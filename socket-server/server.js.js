const WebSocket = require('ws');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');

// Configuration
const config = {
    port: process.env.PORT || 8080,
    jwtSecret: process.env.JWT_SECRET || 'algerrha-virtual-city-secret-key-change-in-production',
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

// WebSocket connection handling
wss.on('connection', async (ws, request) => {
    console.log('🔗 New resident connection attempt');
    
    // Authenticate via JWT token
    const urlParams = new URLSearchParams(request.url.split('?')[1]);
    const token = urlParams.get('token');
    
    if (!token) {
        ws.close(1008, 'Authentication required');
        return;
    }

    try {
        // Simple token decoding (replace with JWT if you add the library)
        const decoded = JSON.parse(Buffer.from(token, 'base64').toString());
        const resident = await verifyWPResident(decoded.residentId);
        
        if (!resident) {
            ws.close(1008, 'Invalid resident');
            return;
        }

        ws.residentId = resident.ID;
        ws.residentData = resident;
        connectedResidents.set(resident.ID, ws);
        
        console.log(`✅ Resident ${resident.display_name} connected`);
        
        // Notify others
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

    } catch (error) {
        console.error('❌ Authentication error:', error);
        ws.close(1008, 'Authentication failed');
        return;
    }

    // Handle messages
    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data);
            await handleMessage(ws, message);
        } catch (error) {
            console.error('Message handling error:', error);
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
        }
    });
});

// Message handler
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
                    sendToUser(message.receiverId, {
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
                }

                broadcastToAll({
                    type: 'post_liked',
                    postId: message.postId,
                    residentId: ws.residentId,
                    residentName: ws.residentData.display_name,
                    likesCount: await getPostLikesCount(connection, message.postId)
                });
                break;

            default:
                console.log('Unknown message type:', message.type);
        }
    } catch (error) {
        console.error('Error handling message:', error);
    } finally {
        await connection.end();
    }
}

// Utility functions
function broadcastToAll(message, excludeResidentId = null) {
    connectedResidents.forEach((client, residentId) => {
        if (residentId !== excludeResidentId && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
}

function sendToResident(residentId, message) {
    const client = connectedResidents.get(parseInt(residentId));
    if (client && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(message));
    }
}

async function getPostLikesCount(connection, postId) {
    const [result] = await connection.execute(
        'SELECT COUNT(*) as count FROM wp_algerrha_likes WHERE post_id = ?',
        [postId]
    );
    return result[0].count;
}

console.log(`✅ Algerrha WebSocket Server running on port ${config.port}`);