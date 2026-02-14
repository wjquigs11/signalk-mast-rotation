# SignalK Mast Rotation Plugin

A SignalK plugin for monitoring and managing mast rotation angle data. This plugin uses NMEA 2000 PGNs from CAN bus interfaces to calculate the mast rotation angle and provides a user interface for calibration.

## Features

- Monitors PGN 130306 (Wind Data) and 127250 (Vessel Heading) from CAN bus
- Calculates mast rotation angle as the difference between boat heading and mast heading
- Provides a web interface for visualizing and calibrating the mast angle
- Stores calibration offset in persistent storage
- Forwards corrected wind data to SignalK server

TBD: change from signalk subscription for boatHeading to directly polling pypilot

## Documentation

- [Mast Rotation Offset Handling](docs/mastrot-offset-handling.md) - Explains how the mastOffset value is handled between persistent storage and the mastrot.js process

## Technical Details

- Stores the following data in variables:
  - `boatHeading`: Vessel heading from pypilot via SignalK
  - `canHeading`: Vessel heading from PGN 127250
  - `mastAngle`: Calculated difference between boat heading and mast heading
  - `mastOffset`: Calibration offset for centering the mast angle
  - `inputAWA`: Apparent Wind Angle from PGN 130306
  - `inputAWS`: Apparent Wind Speed from PGN 130306
  - `outputAWA`: Corrected Apparent Wind Angle

## Prerequisites

- Node.js 14 or later
- SignalK server
- Linux system with CAN bus interface configured
- SocketCAN support
- pypilot (for boat heading data)

## Installation

1. Install this plugin through the SignalK App Store or manually:

```bash
cd ~/.signalk/node_modules
npm install mastrot-plugin
```

2. Restart your SignalK server
3. Enable the plugin in the SignalK server admin UI

## Configuration

The plugin can be configured through the SignalK server admin UI:

- **Mast Rotation Helper Port**: Port number for the Mast Rotation Helper service (default: 3333)

## Usage

Once installed and enabled, the plugin will:

1. Start monitoring the CAN bus for wind data and vessel heading
2. Subscribe to pypilot heading data from SignalK
3. Calculate the mast rotation angle
4. Provide a web interface for visualization and calibration

### Web Interface

Access the web interface through the SignalK server:

```
http://your-signalk-server:3000/plugins/mastrot
```

The interface provides:

- Visual representation of the mast angle
- Current mast angle in degrees
- "Center" button to set the current mast position as center (0 degrees)
- "Reset" button to clear any calibration offset

## How It Works

1. The plugin reads boat heading from pypilot via SignalK
2. It reads mast heading from the CAN bus (PGN 127250)
3. It calculates the difference between these headings as the mast angle
4. The mastOffset value is applied to center the mast angle
5. The corrected wind angle is calculated and sent to SignalK

## Troubleshooting

- Check that the CAN bus interface is properly configured
- Verify that pypilot is providing heading data to SignalK
- Check the SignalK server logs for any error messages
- Ensure the plugin has permission to access the CAN interface

### Common Issues and Solutions

#### SignalK Subscription Errors
If you see errors related to subscriptions like "unsubscribes.push is not a function", the plugin has been updated to use a more compatible subscription format with format and policy parameters.

#### Metadata Errors
If you see errors like "Cannot read properties of undefined (reading 'split')", the plugin now uses a more compatible metadata format that works with the SignalK server.

#### Plugin Configuration Not Found (404)
The plugin now handles 404 errors when accessing the configuration endpoint gracefully. It will:
1. Try to use the specific mastOffset endpoint first
2. Fall back to the full config endpoint if needed
3. Maintain configuration in memory and local backup file if server configuration is unavailable

#### Backup Configuration
The plugin now saves mastOffset to a local file as a backup, ensuring your calibration settings are preserved even if the SignalK configuration endpoint is unavailable.

## Notes

- This plugin requires a properly configured CAN bus interface
- You may need to run the SignalK server with sudo or give it appropriate permissions if your user doesn't have access to the CAN interface
- The mastOffset value is stored in the plugin's persistent configuration and is preserved across restarts

## License

MIT License

Copyright (c) 2026 SignalK Mast Rotation Plugin Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.