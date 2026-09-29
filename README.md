# Live SVD

Live SVD is a VS Code extension for viewing STM32 peripheral registers from CMSIS-SVD files during Cortex-Debug debugging.

## Features

- CMSIS-SVD peripheral tree
- Live register monitoring
- Register field decoding
- WATCH list for selected registers
- Register and field editing
- Automatic connection to the OpenOCD instance started by Cortex-Debug
- Dynamic OpenOCD TCL port detection
- Persistent WATCH list per workspace

## Requirements

- Visual Studio Code
- Cortex-Debug
- OpenOCD
- CMSIS-SVD file for the target MCU

## Configuration

Example `.vscode/settings.json`:

```json
{
    "liveSvd.svdFile": "${workspaceFolder}/STM32F405.svd",
    "liveSvd.openocdHost": "127.0.0.1",
    "liveSvd.refreshMs": 250
}