# SONOFF TRV-ZBT Schedule Manager

A Home Assistant panel for viewing, creating and copying the weekly heating schedules stored on **SONOFF TRV-ZBT** and compatible models connected through **ZHA**.

> **Not for TRVZB.** This integration is not intended for, and has not been tested with, the standard SONOFF **TRVZB** valve.

> Development version.

## Requirements

- Home Assistant with the **ZHA** integration.
- The SONOFF custom ZHA quirk for your model (e.g. `TRV-ZBT.py`). The quirk provides the schedule entities and the private cluster (0xFC11) commands this panel uses. Standard ZHA clusters alone are **not** sufficient.
  - The quirk script is published by SONOFF ([TRV-ZBT_ZHA_Script.zip](https://resource-wangsu.helplook.net/docker_production/a4j0b0/article/D1bJk2PE/attachments/TRV-ZBT_ZHA_Script.zip)). A copy as supplied is included in this repository in the `quirks/` folder for convenience; if in doubt, use the official version from SONOFF.
  - When the quirk is added to ZHA upstream, it will no longer need to be installed separately; this README will be updated accordingly.

Devices are listed in the panel only if ZHA serves them and the quirk cluster is available. A valve without the quirk simply does not appear.

## Installation

1. Install the quirk:
   - copy `TRV-ZBT.py` (see [`quirks/`](quirks/)) to a folder such as `/config/custom_zha_quirks/`,
   - enable it in `configuration.yaml`:
     ```yaml
     zha:
       custom_quirks_path: /config/custom_zha_quirks/
     ```
   - restart Home Assistant and make sure the valve is (re)loaded by ZHA with the quirk applied.
2. Install the integration:
   - **HACS:** add this repository as a custom repository (category *Integration*), install it, restart Home Assistant; or
   - **Manually:** copy `custom_components/sonoff_trv_schedule` to `/config/custom_components/` and restart.
3. Go to *Settings → Devices & services → Add integration* and add **SONOFF TRV-ZBT Schedule Manager**. A **TRV Schedule** entry appears in the sidebar.

## Usage

Choose a valve, then either fetch an existing day to edit it or create a new schedule. Pick the destination days (and, when editing, the destination schedule and valve) and press **Send & apply**. Each day is written and then read back from the valve to confirm it.

## Important notes

- **Active schedule changes.** Selecting a schedule group to fetch or write activates that group on the valve, even if nothing is written. After using the panel the valve may be left on a different active schedule than before; switch it back in ZHA if needed.
- **No additional permission checks.** The integration does not check permissions of the logged-in user. Any logged-in Home Assistant user, **including accounts in the Read only group**, can open the panel and change schedules. The panel is not restricted to administrators.
- Start times use 30-minute steps, up to 12 periods per day, temperatures 5–30 °C in 0.5 °C steps.

## Troubleshooting

- *"No supported SONOFF TRV devices found."* – ZHA may still be starting, the quirk is not loaded for the valve, or the valve is not served by ZHA.
- *"Unable to load panel translations."* – the integration files are incomplete; reinstall.

## License

The integration code is released under the [MIT License](LICENSE). The SONOFF quirk script in `quirks/` is provided by SONOFF and remains subject to the terms of its author.
