#!/bin/bash

# Port to launch on
PORT=9222
# User data directory for the chrome profile to persist login sessions
PROFILE_DIR="$HOME/Library/Application Support/Google/Chrome/MetaviewScraperProfile"

echo "=========================================================="
echo "🚀 Launching Google Chrome with remote debugging on port $PORT..."
echo "📂 Profile directory: $PROFILE_DIR"
echo "🔐 Please log in to Metaview in the launched window."
echo "=========================================================="

/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=$PORT \
  --user-data-dir="$PROFILE_DIR" \
  "https://metaview.app/sourcing" > /dev/null 2>&1 &

echo "Chrome launched in the background."
echo "Once you are logged in and have sourcing tab(s) active, you can run:"
echo "  npm run scrape -- --list"
