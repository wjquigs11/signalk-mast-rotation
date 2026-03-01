#!/bin/bash
# Install mastrot systemd service
# This script generates the service file with correct paths and installs it

set -e

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
WORKING_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"

# Get current user
CURRENT_USER=$(whoami)

echo "Installing mastrot systemd service..."
echo "Working directory: $WORKING_DIR"
echo "User: $CURRENT_USER"

# Generate service file from template
sed -e "s|__USER__|$CURRENT_USER|g" \
    -e "s|__WORKING_DIR__|$WORKING_DIR|g" \
    "$SCRIPT_DIR/mastrot.service.template" > "$SCRIPT_DIR/mastrot.service"

echo "Generated mastrot.service file"

# Copy to systemd directory
echo "Installing service file (requires sudo)..."
sudo cp "$SCRIPT_DIR/mastrot.service" /etc/systemd/system/mastrot.service

# Reload systemd
echo "Reloading systemd..."
sudo systemctl daemon-reload

# Enable service
echo "Enabling mastrot service..."
sudo systemctl enable mastrot

echo ""
echo "Installation complete!"
echo ""

echo "Starting service..."
sudo systemctl start mastrot

echo "To check status:"
echo "  sudo systemctl status mastrot"
echo ""
echo "To view logs:"
echo "  sudo journalctl -u mastrot -f"
echo ""
echo "To customize the service (CAN device, hosts, etc), edit:"
echo "  /etc/systemd/system/mastrot.service"
echo "Then run: sudo systemctl daemon-reload && sudo systemctl restart mastrot"
