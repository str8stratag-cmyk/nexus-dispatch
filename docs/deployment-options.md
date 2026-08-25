# Nexus Dispatch Deployment Options

## Option 1: Local app and local Whisper

- Run Nexus Dispatch and Whisper on the desktop.
- Use MongoDB Atlas for dispatch records, settings, and geocoding data.
- Cost: MongoDB Atlas Free and Geoapify free tier initially cost $0.
- Best when the desktop is available and local-only operation is preferred.

## Option 2: Railway app and Railway Whisper

- Deploy the Node application and the Python Whisper service as separate Railway services.
- Connect the app to Whisper over Railway's private network.
- Use MongoDB Atlas for persistent data.
- Estimated cost: approximately $35-$65+ per month, primarily for Whisper CPU and RAM.
- Best for a fully cloud-hosted, desktop-independent service.

## Option 3: Railway app and local Whisper through a secure tunnel

- Deploy only Nexus Dispatch to Railway.
- Keep Whisper running on the local desktop.
- Route Railway requests to the desktop Whisper service through a secured tunnel.
- Cost: approximately $5-$15 per month for Railway; Cloudflare Tunnel or Tailscale can be free.
- Requires the desktop and local Whisper process to remain running.
- Selected for the current deployment.

## Current decision

Use Option 3. Configure the Railway service with the tunnel URL and a shared Whisper API key. Do not expose the local Whisper service without authentication.
