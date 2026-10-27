import asyncio

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.helpers import device_registry as dr
from homeassistant.components.zha.helpers import get_zha_gateway
from zigpy.types.named import EUI64

from .const import CLUSTER_ID, GROUPS, SCHEDULE_DAYS


def _cluster_for_device(hass, device_id):
    entry = dr.async_get(hass).async_get(device_id)
    if entry is None:
        raise ValueError("Device not found")

    ieee = None

    for kind, value in entry.connections:
        if kind == "zigbee":
            ieee = value
            break

    if ieee is None:
        for domain, value in entry.identifiers:
            if domain == "zha":
                ieee = value
                break

    if ieee is None:
        raise ValueError("ZHA IEEE address not found in device registry")

    gateway = get_zha_gateway(hass)
    zha_device = gateway.get_device(EUI64.convert(str(ieee)))

    if zha_device is None:
        raise ValueError("ZHA device not found")

    cluster = zha_device.async_get_cluster(1, CLUSTER_ID, cluster_type="in")

    if cluster is None:
        for endpoint_id in getattr(zha_device.device, "endpoints", {}):
            if endpoint_id == 0:
                continue
            cluster = zha_device.async_get_cluster(
                endpoint_id, CLUSTER_ID, cluster_type="in"
            )
            if cluster is not None:
                break

    if (
        cluster is None
        or not hasattr(cluster, "schedule_fetch")
        or not hasattr(cluster, "schedule_group_raw")
    ):
        raise ValueError("Compatible SONOFF TRV quirk cluster not found")

    return cluster


def _schedule_lock(cluster):
    """Return the schedule-operation lock belonging to this TRV."""
    lock = getattr(cluster, "_sonoff_trvzbl_schedule_ws_lock", None)
    if lock is None:
        lock = asyncio.Lock()
        setattr(cluster, "_sonoff_trvzbl_schedule_ws_lock", lock)
    return lock


def _validate(periods):
    if not 1 <= len(periods) <= 12:
        raise ValueError("Schedule must contain 1 to 12 periods")

    out = []
    previous = -1

    for i, period in enumerate(periods, 1):
        minutes = int(period["minutes"])
        temp = float(period["temperature"])

        if i == 1 and minutes != 0:
            raise ValueError("Period 1 must start at 00:00")

        if not 0 <= minutes < 1440 or minutes % 30:
            raise ValueError(f"Period {i}: time must use a 30-minute step")

        if minutes <= previous:
            raise ValueError(f"Period {i}: time must be later than the previous period")

        if not 5 <= temp <= 30 or abs(temp * 2 - round(temp * 2)) > 1e-9:
            raise ValueError(
                f"Period {i}: temperature must be 5-30 °C in 0.5 °C steps"
            )

        out.append((minutes, round(temp * 100)))
        previous = minutes

    return out


def _read_editor(cluster):
    periods = []

    for i in range(12):
        minutes = cluster._attr_cache.get(0xF020 + i, 0xFFFF)
        temp = cluster._attr_cache.get(0xF030 + i, 500)

        if int(minutes) != 0xFFFF:
            periods.append(
                {
                    "minutes": int(minutes),
                    "temperature": int(temp) / 100,
                }
            )

    if not periods or periods[0]["minutes"] != 0:
        raise ValueError("TRV returned no valid schedule for the selected day")

    return periods


async def _fetch_locked(cluster, group, day, timeout=10):
    """
    Fetch a schedule while the caller owns the TRV schedule lock.

    The lock is deliberately held by the caller for the entire
    operation so that schedule_editor_group/day cannot be changed
    by another schedule operation while the response is pending.
    """
    # Select the requested group through the quirk's existing write path.
    # For TRV-ZBL this activates the group on the device and synchronizes
    # the editor-group cache; updating 0xF010 alone only changes local state.
    await cluster.write_attributes({"schedule_editor_group": group})
    cluster._update_attribute(0xF011, day)

    loop = asyncio.get_running_loop()
    future = loop.create_future()
    original = cluster.handle_cluster_request

    def listener(hdr, args, *a, **kw):
        result = original(hdr, args, *a, **kw)

        if getattr(hdr, "command_id", None) == 0x13:
            selected_group = int(cluster._attr_cache.get(0xF010, -1))
            selected_day = int(cluster._attr_cache.get(0xF011, 0))
            status = cluster._attr_cache.get(0xF013)

            if (
                selected_group == group
                and selected_day == day
                and status == "fetch loaded"
                and not future.done()
            ):
                future.set_result(True)

        return result

    cluster.handle_cluster_request = listener

    try:
        await cluster.schedule_fetch(expect_reply=False)
        await asyncio.wait_for(future, timeout)
        return _read_editor(cluster)
    finally:
        # Remove the instance-level override so the class method is used again.
        try:
            del cluster.handle_cluster_request
        except AttributeError:
            pass


async def _fetch(cluster, group, day, timeout=10):
    """Fetch a schedule with exclusive access to this TRV."""
    async with _schedule_lock(cluster):
        return await _fetch_locked(cluster, group, day, timeout)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "sonoff_trv_schedule/devices",
    }
)
@websocket_api.async_response
async def ws_devices(hass, connection, msg):
    devices = []

    registry_devices = dr.async_get(hass).devices

    for device in registry_devices:
        if (
            (device.manufacturer or "").upper() == "SONOFF"
            and (device.model or "") in ("TRV-ZBL", "TRV-ZBT")
        ):
            # Only list devices that are served by ZHA and expose the required
            # quirk cluster. This is an in-memory lookup: nothing is sent to the
            # device and no cluster state is changed.
            try:
                _cluster_for_device(hass, device.id)
            except Exception:  # noqa: BLE001 - unsupported or ZHA not ready
                continue

            devices.append(
                {
                    "id": device.id,
                    "name": device.name_by_user or device.name or device.model or "SONOFF TRV",
                }
            )

    connection.send_result(msg["id"], devices)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "sonoff_trv_schedule/fetch",
        vol.Required("device_id"): str,
        vol.Required("group"): vol.In(GROUPS),
        vol.Required("day"): vol.In(SCHEDULE_DAYS),
    }
)
@websocket_api.async_response
async def ws_fetch(hass, connection, msg):
    try:
        cluster = _cluster_for_device(hass, msg["device_id"])

        periods = await _fetch(
            cluster,
            GROUPS[msg["group"]],
            msg["day"],
        )

    except asyncio.TimeoutError:
        connection.send_error(
            msg["id"],
            "timeout",
            "No matching schedule response from SONOFF TRV",
        )
        return

    except Exception as exc:
        connection.send_error(msg["id"], "fetch_failed", str(exc))
        return

    connection.send_result(
        msg["id"],
        {
            "periods": periods,
        },
    )


def _same_schedule(periods, transitions):
    return [
        (
            int(period["minutes"]),
            round(float(period["temperature"]) * 100),
        )
        for period in periods
    ] == transitions


def _normalise_schedule(periods):
    return [
        (
            int(period["minutes"]),
            round(float(period["temperature"]) * 100),
        )
        for period in periods
    ]


async def _apply_one(cluster, group, day, transitions, timeout=10):
    """
    Write and verify one schedule day.

    The caller must hold the per-TRV schedule lock for the entire
    operation. This includes all sleeps and all read-back attempts.
    """
    await cluster.write_attributes(
        {
            "schedule_editor_group": group,
        }
    )

    payload = bytes((1, 1, group, len(transitions), day, 1))

    for minutes, temp in transitions:
        payload += minutes.to_bytes(2, "little") + temp.to_bytes(
            2, "little", signed=True
        )

    await cluster.schedule_group_raw(data=payload, expect_reply=False)

    last_readback = None
    last_error = None

    for delay in (0.75, 1.5, 2.5):
        # IMPORTANT:
        # The caller keeps the per-TRV lock during this sleep.
        # This prevents another operation from changing
        # schedule_editor_group/day before the verification fetch.
        await asyncio.sleep(delay)

        try:
            last_readback = await _fetch_locked(
                cluster,
                group,
                day,
                timeout,
            )

            last_error = None

            if _same_schedule(last_readback, transitions):
                return {
                    "status": "verified",
                    "readback": last_readback,
                }

        except Exception as exc:
            last_error = exc

    return {
        "status": "unverified",
        "readback": last_readback,
        "error": str(last_error) if last_error else None,
    }


@websocket_api.websocket_command(
    {
        vol.Required("type"): "sonoff_trv_schedule/apply",
        vol.Required("device_id"): str,
        vol.Required("group"): vol.In(GROUPS),
        vol.Required("days"): [vol.In(SCHEDULE_DAYS)],
        vol.Required("periods"): list,
    }
)
@websocket_api.async_response
async def ws_apply(hass, connection, msg):
    try:
        transitions = _validate(msg["periods"])

        cluster = _cluster_for_device(hass, msg["device_id"])

        group = GROUPS[msg["group"]]

        days = list(dict.fromkeys(msg["days"]))

        if not days:
            raise ValueError("Select at least one day")

    except Exception as exc:
        connection.send_error(msg["id"], "apply_failed", str(exc))
        return

    verified = []
    unverified = []
    failed = []

    # The lock covers the COMPLETE apply operation:
    #
    #   write
    #   -> sleep
    #   -> fetch
    #   -> compare
    #   -> retry
    #   -> next day
    #
    # This prevents another fetch/apply operation from changing
    # schedule_editor_group/day while verification is in progress.
    async with _schedule_lock(cluster):
        for day in days:
            try:
                result = await _apply_one(
                    cluster,
                    group,
                    day,
                    transitions,
                )

                if result["status"] == "verified":
                    verified.append(day)

                else:
                    detail = {
                        "day": day,
                        "expected": transitions,
                        "readback": (
                            _normalise_schedule(result["readback"])
                            if result["readback"]
                            else None
                        ),
                    }

                    if result.get("error"):
                        detail["error"] = result["error"]

                    unverified.append(detail)

            except Exception as exc:
                failed.append(
                    {
                        "day": day,
                        "error": str(exc),
                    }
                )

    connection.send_result(
        msg["id"],
        {
            "status": "verified" if not unverified and not failed else "partial",
            "days": verified,
            "unverified": unverified,
            "failed": failed,
        },
    )


def async_register_websocket_commands(hass):
    websocket_api.async_register_command(hass, ws_devices)
    websocket_api.async_register_command(hass, ws_fetch)
    websocket_api.async_register_command(hass, ws_apply)
