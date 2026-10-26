from pathlib import Path

from homeassistant.components import frontend
from homeassistant.components.http import StaticPathConfig
from homeassistant.helpers import config_validation as cv

from .const import DOMAIN, PANEL_URL, STATIC_URL
from .websocket import async_register_websocket_commands

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


async def async_setup(hass, config):
    return True


async def async_setup_entry(hass, entry):
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = {}

    if not hass.data[DOMAIN].get("registered"):
        frontend_path = Path(__file__).parent / "frontend"
        translations_path = Path(__file__).parent / "translations"

        await hass.http.async_register_static_paths(
            [
                StaticPathConfig(
                    STATIC_URL,
                    str(frontend_path),
                    False,
                ),
                StaticPathConfig(
                    f"/{DOMAIN}/translations",
                    str(translations_path),
                    False,
                ),
            ]
        )

        frontend.async_register_built_in_panel(
            hass,
            "custom",
            sidebar_title="TRV Schedule",
            sidebar_icon="mdi:radiator",
            frontend_url_path=PANEL_URL,
            config={
                "_panel_custom": {
                    "name": "sonoff-trv-schedule-panel",
                    "module_url": f"{STATIC_URL}/sonoff-trv-schedule.js",
                    "embed_iframe": False,
                    "trust_external": False,
                }
            },
        )

        async_register_websocket_commands(hass)
        hass.data[DOMAIN]["registered"] = True

    return True


async def async_unload_entry(hass, entry):
    hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
    return True