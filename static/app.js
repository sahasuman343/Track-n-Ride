// App State
let sessionId = null;
let username = null;
let ws = null;
let map = null;
let markers = {};
let currentUserMarker = null;
let watchId = null;

// DOM Elements
const loginScreen = document.getElementById('loginScreen');
const appScreen = document.getElementById('appScreen');
const loginForm = document.getElementById('loginForm');
const loginBtn = document.getElementById('loginBtn');
const logoutBtn = document.getElementById('logoutBtn');
const currentUserEl = document.getElementById('currentUser');
const ridersListEl = document.getElementById('ridersList');
const riderCountEl = document.getElementById('riderCount');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    loginForm.addEventListener('submit', handleLogin);
    logoutBtn.addEventListener('click', handleLogout);
});

// Login Handler
async function handleLogin(e) {
    e.preventDefault();
    
    const usernameInput = document.getElementById('username');
    username = usernameInput.value.trim();
    
    if (!username) return;
    
    loginBtn.disabled = true;
    loginBtn.textContent = 'Connecting...';
    
    try {
        const formData = new FormData();
        formData.append('username', username);
        
        const response = await fetch('/api/login', {
            method: 'POST',
            body: formData
        });
        
        if (!response.ok) {
            throw new Error('Login failed');
        }
        
        const data = await response.json();
        sessionId = data.session_id;
        
        // Switch to app screen
        loginScreen.style.display = 'none';
        appScreen.style.display = 'flex';
        currentUserEl.textContent = username;
        
        // Initialize map
        initMap();
        
        // Start location tracking
        startLocationTracking();
        
        // Connect WebSocket
        connectWebSocket();
        
    } catch (error) {
        console.error('Login error:', error);
        alert('Failed to login. Please try again.');
        loginBtn.disabled = false;
        loginBtn.textContent = 'Start Riding';
    }
}

// Logout Handler
async function handleLogout() {
    try {
        const formData = new FormData();
        formData.append('session_id', sessionId);
        
        await fetch('/api/logout', {
            method: 'POST',
            body: formData
        });
    } catch (error) {
        console.error('Logout error:', error);
    }
    
    // Clean up
    if (ws) {
        ws.close();
    }
    
    if (watchId) {
        navigator.geolocation.clearWatch(watchId);
    }
    
    // Reset state
    sessionId = null;
    username = null;
    markers = {};
    
    // Switch back to login screen
    appScreen.style.display = 'none';
    loginScreen.style.display = 'flex';
    loginForm.reset();
    loginBtn.disabled = false;
    loginBtn.textContent = 'Start Riding';
}

// Initialize Map
function initMap() {
    // Create map centered on a default location
    map = L.map('map').setView([20.5937, 78.9629], 5); // India center
    
    // Add tile layer
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 19
    }).addTo(map);
}

// Start Location Tracking
function startLocationTracking() {
    if (!navigator.geolocation) {
        alert('Geolocation is not supported by your browser');
        return;
    }
    
    // Get initial position
    navigator.geolocation.getCurrentPosition(
        (position) => {
            const { latitude, longitude } = position.coords;
            
            // Center map on user's location
            map.setView([latitude, longitude], 15);
            
            // Create marker for current user
            currentUserMarker = L.marker([latitude, longitude], {
                icon: createCustomIcon(username, true)
            }).addTo(map);
            
            currentUserMarker.bindPopup(`<b>You</b><br>${username}`);
        },
        (error) => {
            console.error('Geolocation error:', error);
            showStatus('Please enable location access', 'error');
        }
    );
    
    // Watch position changes
    watchId = navigator.geolocation.watchPosition(
        (position) => {
            const { latitude, longitude, accuracy } = position.coords;
            
            // Update current user marker
            if (currentUserMarker) {
                currentUserMarker.setLatLng([latitude, longitude]);
            }
            
            // Send location update via WebSocket
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'location_update',
                    location: {
                        latitude,
                        longitude,
                        accuracy
                    }
                }));
            }
        },
        (error) => {
            console.error('Geolocation watch error:', error);
        },
        {
            enableHighAccuracy: true,
            maximumAge: 5000,
            timeout: 10000
        }
    );
}

// Connect WebSocket
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/${sessionId}`;
    
    ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
        console.log('WebSocket connected');
        showStatus('Connected to ride', 'success');
    };
    
    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        handleWebSocketMessage(message);
    };
    
    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        showStatus('Connection error', 'error');
    };
    
    ws.onclose = () => {
        console.log('WebSocket disconnected');
    };
}

// Handle WebSocket Messages
function handleWebSocketMessage(message) {
    switch (message.type) {
        case 'initial_state':
            // Load all existing users
            message.users.forEach(user => {
                if (user.session_id !== sessionId && user.location) {
                    addOrUpdateRider(user);
                }
            });
            updateRidersList();
            break;
            
        case 'user_joined':
            if (message.session_id !== sessionId) {
                showStatus(`${message.username} joined the ride`, 'success');
                addOrUpdateRider({
                    session_id: message.session_id,
                    username: message.username
                });
                updateRidersList();
            }
            break;
            
        case 'location_update':
            if (message.session_id !== sessionId) {
                addOrUpdateRider({
                    session_id: message.session_id,
                    username: message.username,
                    location: message.location
                });
                updateRidersList();
            }
            break;
            
        case 'user_left':
            if (message.session_id !== sessionId) {
                showStatus(`${message.username} left the ride`, 'error');
                removeRider(message.session_id);
                updateRidersList();
            }
            break;
    }
}

// Add or Update Rider
function addOrUpdateRider(user) {
    if (!user.location) return;
    
    const { latitude, longitude } = user.location;
    
    if (markers[user.session_id]) {
        // Update existing marker
        markers[user.session_id].setLatLng([latitude, longitude]);
    } else {
        // Create new marker
        const marker = L.marker([latitude, longitude], {
            icon: createCustomIcon(user.username, false)
        }).addTo(map);
        
        marker.bindPopup(`<b>${user.username}</b>`);
        markers[user.session_id] = marker;
    }
}

// Remove Rider
function removeRider(sessionId) {
    if (markers[sessionId]) {
        map.removeLayer(markers[sessionId]);
        delete markers[sessionId];
    }
}

// Update Riders List
function updateRidersList() {
    const riderCount = Object.keys(markers).length + 1; // +1 for current user
    riderCountEl.textContent = `${riderCount} rider${riderCount !== 1 ? 's' : ''} online`;
    
    ridersListEl.innerHTML = '';
    
    // Add current user
    const currentUserItem = createRiderItem(username, true);
    ridersListEl.appendChild(currentUserItem);
    
    // Add other riders
    Object.entries(markers).forEach(([sid, marker]) => {
        const popup = marker.getPopup();
        const riderName = popup.getContent().replace('<b>', '').replace('</b>', '');
        const riderItem = createRiderItem(riderName, false);
        ridersListEl.appendChild(riderItem);
    });
}

// Create Rider Item
function createRiderItem(name, isCurrentUser) {
    const item = document.createElement('div');
    item.className = 'rider-item';
    
    const avatar = document.createElement('div');
    avatar.className = 'rider-avatar';
    avatar.textContent = name.charAt(0).toUpperCase();
    
    const info = document.createElement('div');
    info.className = 'rider-info';
    
    const nameEl = document.createElement('div');
    nameEl.className = 'rider-name';
    nameEl.textContent = name + (isCurrentUser ? ' (You)' : '');
    
    const status = document.createElement('div');
    status.className = 'rider-status';
    status.innerHTML = '<span class="status-dot"></span> Active';
    
    info.appendChild(nameEl);
    info.appendChild(status);
    
    item.appendChild(avatar);
    item.appendChild(info);
    
    return item;
}

// Create Custom Icon
function createCustomIcon(name, isCurrentUser) {
    const iconHtml = `
        <div class="custom-marker" style="${isCurrentUser ? 'background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);' : ''}">
            ${name.charAt(0).toUpperCase()}
        </div>
    `;
    
    return L.divIcon({
        html: iconHtml,
        className: '',
        iconSize: [40, 40],
        iconAnchor: [20, 20],
        popupAnchor: [0, -20]
    });
}

// Show Status Message
function showStatus(message, type) {
    const statusEl = document.createElement('div');
    statusEl.className = `status-message ${type}`;
    statusEl.textContent = message;
    
    document.body.appendChild(statusEl);
    
    setTimeout(() => {
        statusEl.remove();
    }, 3000);
}
