from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Form
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from typing import Dict, Set
import json
import uuid
from datetime import datetime

app = FastAPI(title="Group Bike Ride Tracker")

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory storage
active_sessions: Dict[str, dict] = {}  # session_id -> user_info
active_connections: Dict[str, WebSocket] = {}  # session_id -> websocket


class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}

    async def connect(self, websocket: WebSocket, session_id: str):
        await websocket.accept()
        self.active_connections[session_id] = websocket

    def disconnect(self, session_id: str):
        if session_id in self.active_connections:
            del self.active_connections[session_id]

    async def broadcast(self, message: dict, exclude_session: str = None):
        """Broadcast message to all connected clients except the excluded one"""
        disconnected = []
        for session_id, connection in self.active_connections.items():
            if session_id != exclude_session:
                try:
                    await connection.send_json(message)
                except Exception:
                    disconnected.append(session_id)
        
        # Clean up disconnected clients
        for session_id in disconnected:
            self.disconnect(session_id)

    async def send_personal_message(self, message: dict, session_id: str):
        """Send message to a specific client"""
        if session_id in self.active_connections:
            try:
                await self.active_connections[session_id].send_json(message)
            except Exception:
                self.disconnect(session_id)


manager = ConnectionManager()


@app.post("/api/login")
async def login(username: str = Form(...)):
    """Login endpoint - creates a session for the user"""
    if not username or len(username.strip()) == 0:
        raise HTTPException(status_code=400, detail="Username is required")
    
    username = username.strip()
    
    # Create session
    session_id = str(uuid.uuid4())
    active_sessions[session_id] = {
        "username": username,
        "session_id": session_id,
        "joined_at": datetime.now().isoformat(),
        "location": None
    }
    
    return JSONResponse({
        "session_id": session_id,
        "username": username,
        "message": "Login successful"
    })


@app.post("/api/logout")
async def logout(session_id: str = Form(...)):
    """Logout endpoint - removes the session"""
    if session_id in active_sessions:
        username = active_sessions[session_id]["username"]
        del active_sessions[session_id]
        
        # Notify all clients that user left
        await manager.broadcast({
            "type": "user_left",
            "session_id": session_id,
            "username": username
        })
        
        return JSONResponse({"message": "Logout successful"})
    
    raise HTTPException(status_code=404, detail="Session not found")


@app.get("/api/users")
async def get_active_users():
    """Get list of all active users"""
    users = []
    for session_id, user_info in active_sessions.items():
        users.append({
            "session_id": session_id,
            "username": user_info["username"],
            "location": user_info.get("location")
        })
    return JSONResponse({"users": users})


@app.websocket("/ws/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str):
    """WebSocket endpoint for real-time location updates"""
    
    # Verify session exists
    if session_id not in active_sessions:
        await websocket.close(code=1008, reason="Invalid session")
        return
    
    await manager.connect(websocket, session_id)
    user_info = active_sessions[session_id]
    
    try:
        # Send current state to the newly connected user
        all_users = []
        for sid, info in active_sessions.items():
            all_users.append({
                "session_id": sid,
                "username": info["username"],
                "location": info.get("location")
            })
        
        await manager.send_personal_message({
            "type": "initial_state",
            "users": all_users
        }, session_id)
        
        # Notify all other users that a new user joined
        await manager.broadcast({
            "type": "user_joined",
            "session_id": session_id,
            "username": user_info["username"]
        }, exclude_session=session_id)
        
        # Listen for location updates
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            
            if message.get("type") == "location_update":
                location = message.get("location")
                
                # Update user's location
                active_sessions[session_id]["location"] = location
                
                # Broadcast location update to all other users
                await manager.broadcast({
                    "type": "location_update",
                    "session_id": session_id,
                    "username": user_info["username"],
                    "location": location
                }, exclude_session=session_id)
    
    except WebSocketDisconnect:
        manager.disconnect(session_id)
        
        # Notify all users that this user disconnected
        await manager.broadcast({
            "type": "user_left",
            "session_id": session_id,
            "username": user_info["username"]
        })
    
    except Exception as e:
        print(f"WebSocket error: {e}")
        manager.disconnect(session_id)


# Mount static files
app.mount("/", StaticFiles(directory="static", html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    print("🚴 Group Bike Ride Tracker starting...")
    print("📍 Open http://localhost:8000 in your browser")
    uvicorn.run(app, host="0.0.0.0", port=8000)
