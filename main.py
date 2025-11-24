from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Form
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from typing import Dict, Set, Optional
import json
import uuid
from datetime import datetime
import os
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="Group Bike Ride Tracker")

@app.get("/api/config")
async def get_config():
    return {"google_maps_api_key": os.getenv("GOOGLE_MAPS_API_KEY")}

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory storage
# session_id -> {username, session_id, ride_id, joined_at, location}
active_sessions: Dict[str, dict] = {}
# ride_id -> {created_at, name, admin_session_id, destination}
rides: Dict[str, dict] = {}
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

    async def broadcast_to_ride(self, message: dict, ride_id: str, exclude_session: str = None):
        """Broadcast message to all connected clients in a specific ride"""
        disconnected = []
        
        # Find all sessions in this ride
        ride_sessions = [
            sid for sid, info in active_sessions.items() 
            if info.get("ride_id") == ride_id
        ]
        
        for session_id in ride_sessions:
            if session_id != exclude_session and session_id in self.active_connections:
                connection = self.active_connections[session_id]
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
async def login(
    username: str = Form(...),
    action: str = Form(...),  # 'create' or 'join'
    ride_id: Optional[str] = Form(None)
):
    """Login endpoint - creates a session and handles ride creation/joining"""
    if not username or len(username.strip()) == 0:
        raise HTTPException(status_code=400, detail="Username is required")
    
    username = username.strip()
    if len(username) > 50:
        raise HTTPException(status_code=400, detail="Username too long (max 50 chars)")
        
    session_id = str(uuid.uuid4())
    is_admin = False
    
    # Handle Ride Logic
    if action == "create":
        ride_id = str(uuid.uuid4())[:8]  # Short ID for easier sharing
        rides[ride_id] = {
            "created_at": datetime.now().isoformat(),
            "name": f"{username}'s Ride",
            "admin_session_id": session_id,
            "destination": None
        }
        is_admin = True
    elif action == "join":
        if not ride_id:
            raise HTTPException(status_code=400, detail="Ride ID is required to join")
        
        ride_id = ride_id.strip()
        if len(ride_id) > 20 or not ride_id.isalnum():
             raise HTTPException(status_code=400, detail="Invalid Ride ID format")
             
        if ride_id not in rides:
            raise HTTPException(status_code=404, detail="Ride not found")
    else:
        raise HTTPException(status_code=400, detail="Invalid action")
    
    # Create session
    active_sessions[session_id] = {
        "username": username,
        "session_id": session_id,
        "ride_id": ride_id,
        "joined_at": datetime.now().isoformat(),
        "location": None
    }
    
    return JSONResponse({
        "session_id": session_id,
        "username": username,
        "ride_id": ride_id,
        "is_admin": is_admin,
        "message": "Login successful"
    })


@app.post("/api/logout")
async def logout(session_id: str = Form(...)):
    """Logout endpoint - removes the session"""
    if session_id in active_sessions:
        user_info = active_sessions[session_id]
        username = user_info["username"]
        ride_id = user_info["ride_id"]
        
        del active_sessions[session_id]
        
        # Notify other clients in the ride
        await manager.broadcast_to_ride({
            "type": "user_left",
            "session_id": session_id,
            "username": username
        }, ride_id)
        
        return JSONResponse({"message": "Logout successful"})
    
    # Session already gone - return success (idempotent)
    return JSONResponse({"message": "Logout successful"})


@app.get("/api/ride/{ride_id}/users")
async def get_ride_users(ride_id: str):
    """Get list of active users in a specific ride"""
    if ride_id not in rides:
        raise HTTPException(status_code=404, detail="Ride not found")
        
    users = []
    for session_id, user_info in active_sessions.items():
        if user_info.get("ride_id") == ride_id:
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
    ride_id = user_info["ride_id"]
    ride_info = rides.get(ride_id)
    
    try:
        # Send current state of the ride to the newly connected user
        ride_users = []
        for sid, info in active_sessions.items():
            if info.get("ride_id") == ride_id:
                ride_users.append({
                    "session_id": sid,
                    "username": info["username"],
                    "location": info.get("location")
                })
        
        await manager.send_personal_message({
            "type": "initial_state",
            "users": ride_users,
            "ride_id": ride_id,
            "destination": ride_info.get("destination") if ride_info else None,
            "is_admin": ride_info.get("admin_session_id") == session_id if ride_info else False
        }, session_id)
        
        # Notify other users in the ride that a new user joined
        await manager.broadcast_to_ride({
            "type": "user_joined",
            "session_id": session_id,
            "username": user_info["username"]
        }, ride_id, exclude_session=session_id)
        
        # Listen for location updates
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            msg_type = message.get("type")
            
            if msg_type == "location_update":
                location = message.get("location")
                
                # Update user's location
                active_sessions[session_id]["location"] = location
                
                # Broadcast location update to others in the ride
                await manager.broadcast_to_ride({
                    "type": "location_update",
                    "session_id": session_id,
                    "username": user_info["username"],
                    "location": location
                }, ride_id, exclude_session=session_id)
                
            elif msg_type == "set_destination":
                # Verify user is admin
                if ride_info and ride_info.get("admin_session_id") == session_id:
                    destination = message.get("destination")
                    ride_info["destination"] = destination
                    
                    # Broadcast destination update to ALL users in the ride
                    await manager.broadcast_to_ride({
                        "type": "destination_update",
                        "destination": destination
                    }, ride_id)
    
    except WebSocketDisconnect:
        manager.disconnect(session_id)
        
        # Notify others in the ride
        await manager.broadcast_to_ride({
            "type": "user_left",
            "session_id": session_id,
            "username": user_info["username"]
        }, ride_id)
    
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
