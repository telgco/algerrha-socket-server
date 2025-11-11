const WebSocket = require('ws');
const mysql = require('mysql2/promise');

// Configuration
const config = {
    port: process.env.PORT || 8080,
    database: {
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
    }
};

const wss = new WebSocket.Server({ port: config.port });
const connectedResidents = new Map();

console.log(`🏙️ Algerrha Virtual City WebSocket Server starting on port ${config.port}`);

// Simple token decoding (no JWT library needed)
function decodeToken(token) {
    try {
        return JSON.parse(Buffer.from(token, 'base64').toString());
    } catch (error) {
        throw new Error('Invalid token');
    }
}

// Verify WordPress resident
async function verifyWPResident(residentId) {
    try {
        const connection = await mysql.createConnection(config.database);
        const [rows] = await connection.execute(
            'SELECT ID, user_login, display_name, user_email FROM wp_users WHERE ID = ? AND user_status = 0',
            [residentId]
        );
        await connection.end();
        return rows.length > 0 ? rows[0] : null;
    } catch (error) {
        console.error('Database error:', error);
        return null;
    }
}

// Broadcast to all connected residents
function broadcastToAll(message, excludeResidentId = null) {
    connectedResidents.forEach((client, residentId) => {
        if (residentId !== excludeResidentId && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
}

// Send to specific resident
function sendToResident(residentId, message) {
    const client = connectedResidents.get(parseInt(residentId));
    if (client && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(message));
    }
}

// Get post likes count
async function getPostLikesCount(connection, postId) {
    const [result] = await connection.execute(
        'SELECT COUNT(*) as count FROM wp_algerrha_likes WHERE post_id = ?',
        [postId]
    );
    return result[0].count;
}

// Handle different message types
async function handleMessage(ws, message) {
    const connection = await mysql.createConnection(config.database);
    
    try {
        switch (message.type) {
            case 'chat_message':
                // Save message to database
                const [result] = await connection.execute(
                    `INSERT INTO wp_algerrha_messages 
                    (sender_id, receiver_id, content, created_at) 
                    VALUES (?, ?, ?, NOW())`,
                    [ws.residentId, message.receiverId || 0, message.content]
                );

                // Broadcast message
                const chatMessage = {
                    type: 'chat_message',
                    id: result.insertId,
                    sender: {
                        id: ws.residentId,
                        name: ws.residentData.display_name,
                        login: ws.residentData.user_login
                    },
                    content: message.content,
                    timestamp: new Date().toISOString(),
                    receiverId: message.receiverId
                };

                if (message.receiverId) {
                    // Private message
                    sendToResident(message.receiverId, chatMessage);
                } else {
                    // City-wide message
                    broadcastToAll(chatMessage, ws.residentId);
                }
                break;

            case 'typing':
                if (message.receiverId) {
                    sendToResident(message.receiverId, {
                        type: 'resident_typing',
                        residentId: ws.residentId,
                        residentName: ws.residentData.display_name,
                        isTyping: message.isTyping
                    });
                }
                break;

            case 'post_like':
                const [existingLike] = await connection.execute(
                    'SELECT id FROM wp_algerrha_likes WHERE post_id = ? AND resident_id = ?',
                    [message.postId, ws.residentId]
                );

                if (existingLike.length === 0) {
                    await connection.execute(
                        'INSERT INTO wp_algerrha_likes (post_id, resident_id, created_at) VALUES (?, ?, NOW())',
                        [message.postId, ws.residentId]
                    );
                    
                    await connection.execute(
                        'UPDATE wp_algerrha_posts SET likes_count = likes_count + 1 WHERE id = ?',
                        [message.postId]
                    );

                    broadcastToAll({
                        type: 'post_liked',
                        postId: message.postId,
                        residentId: ws.residentId,
                        residentName: ws.residentData.display_name,
                        likesCount: await getPostLikesCount(connection, message.postId)
                    });
                }
                break;

            case 'post_comment':
                const [commentResult] = await connection.execute(
                    'INSERT INTO wp_algerrha_comments (post_id, resident_id, content, created_at) VALUES (?, ?, ?, NOW())',
                    [message.postId, ws.residentId, message.content]
                );
                
                await connection.execute(
                    'UPDATE wp_algerrha_posts SET comments_count = comments_count + 1 WHERE id = ?',
                    [message.postId]
                );
                
                broadcastToAll({
                    type: 'post_commented',
                    postId: message.postId,
                    comment: {
                        id: commentResult.insertId,
                        content: message.content,
                        resident: {
                            id: ws.residentId,
                            name: ws.residentData.display_name
                        },
                        timestamp: new Date().toISOString()
                    }
                });
                break;

            case 'get_online_residents':
                const onlineResidents = Array.from(connectedResidents.values()).map(client => ({
                    id: client.residentId,
                    name: client.residentData.display_name,
                    login: client.residentData.user_login
                }));
                
                ws.send(JSON.stringify({
                    type: 'online_residents',
                    residents: onlineResidents
                }));
                break;

            default:
                console.log('Unknown message type:', message.type);
                ws.send(JSON.stringify({
                    type: 'error',
                    message: 'Unknown message type'
                }));
        }
    } catch (error) {
        console.error('Error handling message:', error);
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Failed to process message'
        }));
    } finally {
        await connection.end();
    }
}

// WebSocket connection handling
wss.on('connection', async (ws, request) => {
    console.log('🔗 New resident connection attempt');
    
    // Authenticate via token
    const urlParams = new URLSearchParams(request.url.split('?')[1]);
    const token = urlParams.get('token');
    
    if (!token) {
        ws.close(1008, 'Authentication required');
        return;
    }

    try {
        // Simple token decoding
        const decoded = decodeToken(token);
        const resident = await verifyWPResident(decoded.residentId);
        
        if (!resident) {
            ws.close(1008, 'Invalid resident');
            return;
        }

        ws.residentId = resident.ID;
        ws.residentData = resident;
        connectedResidents.set(resident.ID, ws);
        
        console.log(`✅ Resident ${resident.display_name} connected to virtual city`);
        
        // Notify others about resident coming online
        broadcastToAll({
            type: 'resident_online',
            resident: {
                id: resident.ID,
                name: resident.display_name,
                login: resident.user_login
            }
        }, ws.residentId);

        // Send current online residents
        const onlineResidents = Array.from(connectedResidents.values()).map(client => ({
            id: client.residentId,
            name: client.residentData.display_name,
            login: client.residentData.user_login
        }));
        
        ws.send(JSON.stringify({
            type: 'online_residents',
            residents: onlineResidents
        }));

        // Send welcome message
        ws.send(JSON.stringify({
            type: 'system_message',
            message: `🏙️ Welcome to Algerrha Virtual City, ${resident.display_name}!`,
            timestamp: new Date().toISOString()
        }));

    } catch (error) {
        console.error('❌ Authentication error:', error);
        ws.close(1008, 'Authentication failed');
        return;
    }

    // Handle incoming messages
    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data);
            await handleMessage(ws, message);
        } catch (error) {
            console.error('❌ Message handling error:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Invalid message format'
            }));
        }
    });

    // Handle disconnection
    ws.on('close', () => {
        if (ws.residentId) {
            connectedResidents.delete(ws.residentId);
            broadcastToAll({
                type: 'resident_offline',
                resident: { id: ws.residentId }
            });
            console.log(`👋 Resident ${ws.residentData?.display_name} disconnected`);
        }
    });

    // Handle errors
    ws.on('error', (error) => {
        console.error('❌ WebSocket error:', error);
    });
});

// Handle server errors
wss.on('error', (error) => {
    console.error('❌ WebSocket server error:', error);
});

console.log(`✅ Algerrha Virtual City WebSocket Server running on port ${config.port}`);
console.log('📡 Waiting for resident connections...');