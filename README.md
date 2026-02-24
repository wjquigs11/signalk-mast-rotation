# SignalK Mast Rotation Plugin

A SignalK plugin for monitoring mast rotation angle and correcting masthead AWA based on the mast angle. This plugin reads wind data from a CAN/N2K bus, reads magnetic heading of the boat from local compass/pypilot, and magnetic heading of the mast from remote compass/pypilot. It uses the difference in headings to calculate a correction for AWA, and sends the corrected AWA to SK, where the SK-to-N2K plugin transmits the corrected AWA on a different CAN bus.

![Mast Rotation Plugin](docs/screen-shot.png)

Most of the work is done by a helper service spawned by the plugin; the plugin is mostly a configuration and reporting interface.

How to use: on your SignalK server:
    cd .signalk (or wherever your signalk configuration directory resides)
    npm install https://github.com/wjquigs11/signalk-mast-rotation

I use Raspberry Pi with ICM‑20948 IMU module. SignalK runs on a Pi4 or 5, and the mast compass uses a Pi Zero 2W. I can provide ready-made compasses if needed.

I am currently using a fork of pypilot on the mast compass: https://github.com/wjquigs11/pypilot-mastcompass
The pypilot master does not have a way of disabling zeroconf, so the mast compass always attempts to connect to a SignalK server, which can result in invalid heading. The fork disabled zeroconf and only connects to the specified SK server in the configuration file.

The IMUs are, for the most part, self-calibrating and calibration improves with time on the boat. Follow pypilot calibration instructions if you are mounting in a non-typical orientation (for example, the mast compass mounted vertically on the mast instead of horizontally on the rotation arm).

Once the IMU/compasses have been installed and calibrated (at minimum, by sailing/motoring in several circles), align the mast on centerline and press the "Center" button in the plugin. This typically only needs to be done once.

![Mast Rotation Plugin Config](docs/plugin-config.png)


