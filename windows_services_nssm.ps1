# windows_services_nssm.ps1
# Replace paths and TUNNEL_NAME with your actual values before running.
# Requires NSSM to be installed and nssm.exe available in PATH.

# Install TelNavi server service
nssm install telnavi-server "C:\Program Files\nodejs\node.exe" "C:\opt\telnavi-n8n\server.js"
nssm set telnavi-server AppDirectory "C:\opt\telnavi-n8n"
nssm set telnavi-server Start SERVICE_AUTO_START
nssm start telnavi-server

# Install Cloudflared tunnel service
nssm install telnavi-cloudflared "C:\Program Files\cloudflared\cloudflared.exe" tunnel run TUNNEL_NAME
nssm set telnavi-cloudflared AppDirectory "C:\Program Files\cloudflared"
nssm set telnavi-cloudflared Start SERVICE_AUTO_START
nssm start telnavi-cloudflared

