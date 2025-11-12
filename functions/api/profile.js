// functions/api/profile.js
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { getAuthenticatedUser } = require('../utils/auth');

const db = admin.firestore();

// ==================================================================
// 1. [API] 사용자 프로필 조회 함수
// ==================================================================
const getUserProfile = functions.runWith({ secrets: ["OPENAI_API_KEY"] }).https.onRequest(async (request, response) => {
    response.set('Access-Control-Allow-Origin', '*');
    response.set('Access-Control-Allow-Methods', 'GET, POST');
    response.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (request.method === 'OPTIONS') {
        response.status(204).send('');
        return;
    }

    try {
        const user = await getAuthenticatedUser(request);
        const userId = user.uid;

        const userProfileRef = db.collection('users').doc(userId);
        const userProfileSnap = await userProfileRef.get();

        if (userProfileSnap.exists) {
            response.status(200).json({
                status: 'found',
                profile: userProfileSnap.data()
            });
        } else {
            response.status(200).json({
                status: 'not_found'
            });
        }
    } catch (error) {
        if (error.message.includes('토큰')) {
            response.status(401).json({ status: "error", message: error.message });
        } else {
            response.status(500).json({ status: "error", message: "서버 내부 오류", details: error.message });
        }
    }
});

// ==================================================================
// 2. [API] 사용자 프로필 생성/업데이트 함수
// ==================================================================
const createUserProfile = functions.runWith({ secrets: ["OPENAI_API_KEY"] }).https.onRequest(async (request, response) => {
    response.set('Access-Control-Allow-Origin', '*');
    response.set('Access-Control-Allow-Methods', 'POST');
    response.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (request.method === 'OPTIONS') {
        response.status(204).send('');
        return;
    }
    
    if (request.method !== 'POST') {
        return response.status(405).send('Only POST requests are allowed.');
    }

    try {
        const user = await getAuthenticatedUser(request);
        const userId = user.uid;

        const { readingProfile, knownTopics } = request.body;

        if (!readingProfile || !knownTopics) {
            return response.status(400).send('Invalid profile data.');
        }

        const profileData = {
            readingProfile: readingProfile,
            knownTopics: knownTopics,
            email: user.email,
            displayName: user.name || null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        const userProfileRef = db.collection('users').doc(userId);
        await userProfileRef.set(profileData, { merge: true });

        response.status(201).json({
            status: 'success',
            message: 'Profile created/updated successfully.',
            profile: profileData
        });

    } catch (error) {
        if (error.message.includes('토큰')) {
            response.status(401).json({ status: "error", message: error.message });
        } else {
            response.status(500).json({ status: "error", message: "서버 내부 오류", details: error.message });
        }
    }
});

module.exports = {
    getUserProfile,
    createUserProfile
};
