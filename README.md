# SignalK Mast Rotation Plugin

A SignalK plugin for monitoring mast rotation angle and correcting masthead AWA based on the mast angle. This plugin reads wind data from a CAN/N2K bus, reads magnetic heading of the boat from local pypilot, and magnetic heading of the mast from remote pypilot. It uses the difference in headings to calculate a correction for AWA, and sends the corrected AWA to SK, where the SK-to-N2K plugin transmits the corrected AWA on a different CAN bus.

Most of the work is done by a helper service spawned by the plugin; the plugin is mostly a configuration and reporting interface.

(Note that it's possible to transmit on the same CAN bus but I have Garmin instruments and they do not allow configuration of source so I've built it for the "worst case" scenario.)

