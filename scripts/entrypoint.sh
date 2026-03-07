#!/bin/sh
# Container entrypoint: runs the main server and scheduler in one container.

# Construct DATABASE_URL from individual RDS secret fields if not already set
if [ -z "$DATABASE_URL" ] && [ -n "$DB_HOST" ]; then
    export DATABASE_URL="postgresql://${DB_USERNAME}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
    echo "[entrypoint] DATABASE_URL constructed from RDS credentials"
fi

# Forward signals to both processes for graceful shutdown
shutdown() {
    echo "[entrypoint] Shutting down..."
    kill "$SERVER_PID" "$SCHEDULER_PID" 2>/dev/null || true
    wait "$SERVER_PID" "$SCHEDULER_PID" 2>/dev/null || true
    exit 0
}

trap shutdown TERM INT

echo "[entrypoint] Starting scheduler in background..."
tsx server/scheduler/index.ts &
SCHEDULER_PID=$!

echo "[entrypoint] Starting main server (PID will follow)..."
tsx server/index.ts &
SERVER_PID=$!

echo "[entrypoint] Server PID=$SERVER_PID, Scheduler PID=$SCHEDULER_PID"

# Wait for both; if either exits, stop the other
wait "$SERVER_PID" "$SCHEDULER_PID" 2>/dev/null
echo "[entrypoint] A process exited, shutting down..."
shutdown
