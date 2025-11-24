// --- App State ---
const state = {
    sessionId: null,
    username: null,
    rideId: null,
    isAdmin: false,
    ws: null,
    map: null,
    markers: {}, // Remote riders
    currentUserMarker: null, // You
    watchId: null,
    GOOGLE_MAPS_API_KEY: '',
    mapLoaderPromise: null // Promise to track API loading status
};

// --- Color Palette for Rider Markers ---
const RIDER_COLORS = [
    '#10b981', // Green
    '#f59e0b', // Orange  
    '#8b5cf6', // Purple
    '#ec4899', // Pink
    '#14b8a6', // Teal
    '#f97316', // Deep Orange
    '#06b6d4', // Cyan
    '#84cc16', // Lime
    '#6366f1', // Indigo
    '#ef4444'  // Red
];

// Generate consistent color for a session ID
function getColorForSession(sessionId) {
    let hash = 0;
    for (let i = 0; i < sessionId.length; i++) {
        hash = sessionId.charCodeAt(i) + ((hash << 5) - hash);
    }
    return RIDER_COLORS[Math.abs(hash) % RIDER_COLORS.length];
}

// --- DOM Elements ---
const elements = {
    loginScreen: document.getElementById('loginScreen'),
    appScreen: document.getElementById('appScreen'),
    loginForm: document.getElementById('loginForm'),
    logoutBtn: document.getElementById('logoutBtn'),
    currentUserEl: document.getElementById('currentUser'),
    ridersListEl: document.getElementById('ridersList'),
    riderCountEl: document.getElementById('riderCount'),
    currentRideIdEl: document.getElementById('currentRideId'),
    shareBtn: document.getElementById('shareBtn'),
    createBtn: document.getElementById('createBtn'),
    joinBtnToggle: document.getElementById('joinBtnToggle'),
    joinBtn: document.getElementById('joinBtn'),
    backToCreate: document.getElementById('backToCreate'),
    rideIdGroup: document.getElementById('rideIdGroup'),
    rideIdInput: document.getElementById('rideId'),
    mapContainer: document.getElementById('map')
};

// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
    // 1. Fetch Configuration & Start Map Loading
    try {
        const response = await fetch('/api/config');
        const config = await response.json();
        state.GOOGLE_MAPS_API_KEY = config.google_maps_api_key;

        if (!state.GOOGLE_MAPS_API_KEY) {
            console.warn('Google Maps API Key not set');
            showStatus('API Key missing. Map will not load.', 'error');
        } else {
            // Store the promise so we can await it during login
            state.mapLoaderPromise = loadGoogleMapsAPI();
        }
    } catch (error) {
        console.error('Failed to load config:', error);
        showStatus('Failed to load configuration', 'error');
    }

    // 2. Check URL for Ride ID (Join Link)
    const urlParams = new URLSearchParams(window.location.search);
    const urlRideId = urlParams.get('ride_id');

    if (urlRideId) {
        showJoinMode(urlRideId);
    }

    // 3. Event Listeners
    elements.loginForm.addEventListener('submit', handleLogin);
    elements.logoutBtn.addEventListener('click', handleLogout);
    elements.shareBtn.addEventListener('click', handleShare);

    elements.joinBtnToggle.addEventListener('click', () => showJoinMode());
    elements.backToCreate.addEventListener('click', () => showCreateMode());
});

// --- Google Maps Loader ---
function loadGoogleMapsAPI() {
    return new Promise((resolve, reject) => {
        if (window.google && window.google.maps) {
            resolve(); // Already loaded
            return;
        }

        window.initGoogleMap = () => {
            console.log('Google Maps API loaded successfully');
            resolve();
        };

        window.gm_authFailure = () => {
            showStatus('Google Maps API key is invalid', 'error');
            reject(new Error('Google Maps auth failed'));
        };

        const script = document.createElement('script');
        script.src = `https://maps.googleapis.com/maps/api/js?key=${state.GOOGLE_MAPS_API_KEY}&callback=initGoogleMap`;
        script.async = true;
        script.defer = true;
        script.onerror = (err) => reject(err);
        document.head.appendChild(script);
    });
}

// --- UI Modes ---
function showJoinMode(prefillRideId = null) {
    elements.rideIdGroup.style.display = 'block';
    elements.createBtn.style.display = 'none';
    elements.joinBtnToggle.style.display = 'none';
    elements.joinBtn.style.display = 'block';
    elements.backToCreate.style.display = 'block';
    elements.rideIdInput.required = true; // Enforce validation
    if (prefillRideId) elements.rideIdInput.value = prefillRideId;
}

function showCreateMode() {
    elements.rideIdGroup.style.display = 'none';
    elements.createBtn.style.display = 'block';
    elements.joinBtnToggle.style.display = 'block';
    elements.joinBtn.style.display = 'none';
    elements.backToCreate.style.display = 'none';
    elements.rideIdInput.required = false;
    elements.rideIdInput.value = '';
}

// --- Login Handler ---
async function handleLogin(e) {
    e.preventDefault();

    const usernameInput = document.getElementById('username');
    state.username = usernameInput.value.trim();

    if (!state.username) {
        showStatus('Please enter your name', 'error');
        return;
    }

    const submitBtn = e.submitter;
    const action = submitBtn.value; // 'create' or 'join'
    const originalBtnText = submitBtn.textContent;

    // Validate Ride ID if joining
    if (action === 'join') {
        state.rideId = elements.rideIdInput.value.trim();
        if (!state.rideId) {
            showStatus('Please enter a Ride ID', 'error');
            return;
        }
    }

    // UI Loading State
    submitBtn.disabled = true;
    submitBtn.textContent = 'Connecting...';

    try {
        // 1. Perform API Login
        const formData = new FormData();
        formData.append('username', state.username);
        formData.append('action', action);
        if (action === 'join') formData.append('ride_id', state.rideId);

        const response = await fetch('/api/login', { method: 'POST', body: formData });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.detail || 'Login failed');
        }

        const data = await response.json();
        state.sessionId = data.session_id;
        state.rideId = data.ride_id;
        state.isAdmin = data.is_admin || false;

        // 2. Wait for Map API to be ready (Fixes Race Condition)
        if (state.mapLoaderPromise) {
            await state.mapLoaderPromise;
        }

        // 3. Switch Screens
        elements.loginScreen.style.display = 'none';
        elements.appScreen.style.display = 'flex';
        elements.currentUserEl.textContent = state.username;

        // 4. Update Info Display
        if (elements.currentRideIdEl) {
            elements.currentRideIdEl.style.display = 'inline-block';
            elements.currentRideIdEl.textContent = `Ride ID: ${state.rideId}`;
            elements.currentRideIdEl.onclick = () => {
                navigator.clipboard.writeText(state.rideId);
                showStatus('Ride ID copied!', 'success');
            };
        }

        // 5. Initialize Map (Now that container is visible)
        initMap();

        // 6. Start Tracking & WebSocket
        startLocationTracking();
        connectWebSocket();

    } catch (error) {
        console.error('Login error:', error);
        showStatus(error.message || 'Failed to login', 'error');
    } finally {
        // Always reset button state
        submitBtn.disabled = false;
        submitBtn.textContent = originalBtnText;
    }
}

// --- Logout Handler ---
async function handleLogout(callApi = true) {
    if (state.sessionId && callApi) {
        try {
            const formData = new FormData();
            formData.append('session_id', state.sessionId);
            navigator.sendBeacon('/api/logout', formData); // More reliable on unload
        } catch (e) { console.error(e); }
    }

    // Cleanup
    if (state.ws) state.ws.close();
    if (state.watchId) navigator.geolocation.clearWatch(state.watchId);

    // Reset State
    state.sessionId = null;
    state.username = null;
    state.rideId = null;
    state.isAdmin = false;
    state.markers = {};
    state.map = null;
    state.currentUserMarker = null;

    // Reset UI
    elements.appScreen.style.display = 'none';
    elements.loginScreen.style.display = 'flex';
    elements.loginForm.reset();
    if (elements.ridersListEl) elements.ridersListEl.innerHTML = '';
    if (elements.currentRideIdEl) elements.currentRideIdEl.style.display = 'none';
    showCreateMode();
}

// --- Share Handler ---
function handleShare() {
    if (!state.rideId) return;
    const shareUrl = `${window.location.origin}${window.location.pathname}?ride_id=${state.rideId}`;

    if (navigator.share) {
        navigator.share({
            title: 'Join my bike ride!',
            text: `Ride ID: ${state.rideId}`,
            url: shareUrl
        }).catch(console.error);
    } else {
        navigator.clipboard.writeText(shareUrl)
            .then(() => showStatus('Link copied!', 'success'))
            .catch(() => showStatus('Failed to copy', 'error'));
    }
}

// --- Map Logic ---
function initMap() {
    if (typeof google === 'undefined') return;

    try {
        state.map = new google.maps.Map(elements.mapContainer, {
            center: { lat: 20.5937, lng: 78.9629 }, // Default India
            zoom: 15,
            mapTypeControl: false,
            streetViewControl: false,
            fullscreenControl: true,
            styles: [/* Optional: Add dark mode styles here */]
        });
        console.log('Map initialized');
    } catch (error) {
        console.error('Map init error:', error);
        showStatus('Error initializing map', 'error');
    }
}

// --- Geolocation Logic ---
function startLocationTracking() {
    if (!navigator.geolocation) {
        showStatus('Geolocation not supported', 'error');
        return;
    }

    const geoOptions = {
        enableHighAccuracy: true,
        maximumAge: 0,      // Force fresh data
        timeout: 10000
    };

    // Use watchPosition immediately (it triggers once immediately usually)
    state.watchId = navigator.geolocation.watchPosition(
        (position) => {
            const { latitude, longitude } = position.coords;
            const pos = { lat: latitude, lng: longitude };

            // 1. Update Map Center (Optional: only follow if user hasn't dragged map? Keeping simple here)
            if (state.map && !state.currentUserMarker) {
                state.map.setCenter(pos);
            }

            // 2. Update/Create Marker
            updateCurrentUserMarker(pos);

            // 3. Broadcast to WS
            if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                state.ws.send(JSON.stringify({
                    type: 'location_update',
                    location: pos
                }));
            }
        },
        (error) => {
            console.warn('Geo error:', error.code, error.message);
            if (error.code === 1) showStatus('Location permission denied', 'error');
        },
        geoOptions
    );
}

function updateCurrentUserMarker(pos) {
    if (!state.map) return;

    if (state.currentUserMarker) {
        state.currentUserMarker.setPosition(pos);
    } else {
        state.currentUserMarker = new google.maps.Marker({
            position: pos,
            map: state.map,
            title: "You",
            zIndex: 999, // Keep user on top
            icon: {
                path: google.maps.SymbolPath.CIRCLE,
                scale: 10,
                fillColor: '#3b82f6', // Blue
                fillOpacity: 1,
                strokeColor: '#ffffff',
                strokeWeight: 2
            }
        });

        // Simple info window
        const infoWindow = new google.maps.InfoWindow({ content: '<strong>You</strong>' });
        state.currentUserMarker.addListener('click', () => infoWindow.open(state.map, state.currentUserMarker));
    }
}

// --- WebSocket Logic ---
function connectWebSocket() {
    // Prevent duplicate connections
    if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
        return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/${state.sessionId}`;

    state.ws = new WebSocket(wsUrl);

    state.ws.onopen = () => {
        console.log('WS Connected');
        showStatus('Connected to ride', 'success');
    };

    state.ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleWebSocketMessage(data);
        } catch (e) {
            console.error('Failed to parse WS message', e);
        }
    };

    state.ws.onclose = (event) => {
        console.log('WS Closed', event.code, event.reason);

        // If session is invalid (server sent 1008), don't reconnect
        if (event.code === 1008) {
            showStatus('Session expired. Please login again.', 'error');
            handleLogout(false); // false = skip API call
            return;
        }

        // Only reconnect if we are still logged in (session exists)
        if (state.sessionId) {
            setTimeout(() => {
                console.log('Reconnecting...');
                connectWebSocket();
            }, 3000);
        }
    };
}

function handleWebSocketMessage(data) {
    switch (data.type) {
        case 'initial_state':
            // Received when first connecting - shows all current riders
            if (data.users) {
                updateRidersList(data.users);
                // Display all existing riders on map
                data.users.forEach(user => {
                    if (user.session_id !== state.sessionId && user.location) {
                        updateRemoteRiderMarker(user.session_id, user.username, user.location);
                    }
                });
            }
            break;
        case 'user_joined':
            showStatus(`${data.username} joined`, 'success');
            // Refresh the riders list
            fetchAndUpdateRidersList();

            // Send our location immediately so the new user can see us
            if (state.currentUserMarker) {
                const pos = state.currentUserMarker.getPosition();
                if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                    state.ws.send(JSON.stringify({
                        type: 'location_update',
                        location: { lat: pos.lat(), lng: pos.lng() }
                    }));
                }
            }
            break;
        case 'user_left':
            showStatus(`${data.username} left`, 'error');
            removeMarker(data.session_id);
            // Refresh the riders list
            fetchAndUpdateRidersList();
            break;
        case 'location_update':
            // Don't update self via socket (too much lag), relying on local Geolocation
            if (data.session_id !== state.sessionId) {
                updateRemoteRiderMarker(data.session_id, data.username, data.location);
                // Also update the list to ensure location status is correct
                // Debounce this if performance becomes an issue
            }
            break;
        case 'riders_update':
            updateRidersList(data.riders);
            break;
    }
}

// Helper function to fetch current riders list from API
async function fetchAndUpdateRidersList() {
    if (!state.rideId) return;

    try {
        const response = await fetch(`/api/ride/${state.rideId}/users`);
        if (response.ok) {
            const data = await response.json();
            updateRidersList(data.users);
        }
    } catch (error) {
        console.error('Failed to fetch riders list:', error);
    }
}

function updateRemoteRiderMarker(sessionId, username, location) {
    if (!state.map) return;

    if (state.markers[sessionId]) {
        state.markers[sessionId].setPosition(location);
    } else {
        const markerColor = getColorForSession(sessionId);
        const marker = new google.maps.Marker({
            position: location,
            map: state.map,
            title: username,
            icon: {
                path: google.maps.SymbolPath.CIRCLE,
                scale: 8,
                fillColor: markerColor, // Unique color for each rider
                fillOpacity: 1,
                strokeColor: '#ffffff',
                strokeWeight: 2
            }
        });

        const infoWindow = new google.maps.InfoWindow({ content: `<strong>${username}</strong>` });
        marker.addListener('click', () => infoWindow.open(state.map, marker));

        state.markers[sessionId] = marker;
    }
}

function removeMarker(sessionId) {
    if (state.markers[sessionId]) {
        state.markers[sessionId].setMap(null);
        delete state.markers[sessionId];
    }
}

function updateRidersList(riders) {
    if (!elements.ridersListEl) return;
    elements.ridersListEl.innerHTML = '';
    elements.riderCountEl.textContent = `${riders.length} rider${riders.length !== 1 ? 's' : ''}`;

    riders.forEach(rider => {
        const div = document.createElement('div');
        div.className = 'rider-item';
        div.style.cursor = 'pointer';
        div.style.display = 'flex';
        div.style.alignItems = 'center';
        div.style.gap = '10px';

        // Determine color: Blue for current user, hashed color for others
        const isCurrentUser = rider.session_id === state.sessionId;
        const color = isCurrentUser ? '#3b82f6' : getColorForSession(rider.session_id);

        // Create colored dot
        const dot = document.createElement('span');
        dot.style.width = '12px';
        dot.style.height = '12px';
        dot.style.borderRadius = '50%';
        dot.style.backgroundColor = color;
        dot.style.display = 'inline-block';

        // Create name span
        const nameSpan = document.createElement('span');
        nameSpan.textContent = rider.username + (isCurrentUser ? ' (You)' : '');

        div.appendChild(dot);
        div.appendChild(nameSpan);

        // Click to center map
        div.onclick = () => {
            if (state.map && rider.location) {
                state.map.panTo(rider.location);
                state.map.setZoom(17);

                // Open info window if it's a remote rider
                if (!isCurrentUser && state.markers[rider.session_id]) {
                    google.maps.event.trigger(state.markers[rider.session_id], 'click');
                } else if (isCurrentUser && state.currentUserMarker) {
                    google.maps.event.trigger(state.currentUserMarker, 'click');
                }
            } else {
                showStatus('Location not available for this rider', 'error');
            }
        };

        elements.ridersListEl.appendChild(div);
    });
}

// --- Utilities ---
function showStatus(message, type = 'success') {
    const statusEl = document.createElement('div');
    statusEl.className = `status-message ${type}`;
    statusEl.textContent = message;

    // Basic styling injection to ensure it works without external CSS
    Object.assign(statusEl.style, {
        position: 'fixed',
        top: '20px',
        left: '50%',
        transform: 'translateX(-50%)',
        padding: '10px 20px',
        borderRadius: '8px',
        color: '#fff',
        fontWeight: 'bold',
        zIndex: '10000',
        backgroundColor: type === 'success' ? '#10b981' : '#ef4444',
        boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
        transition: 'opacity 0.3s ease'
    });

    document.body.appendChild(statusEl);

    setTimeout(() => {
        statusEl.style.opacity = '0';
        setTimeout(() => statusEl.remove(), 300);
    }, 3000);
}