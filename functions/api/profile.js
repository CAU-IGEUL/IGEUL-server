// functions/api/profile.js
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const cors = require('cors')({ origin: true });
const { getAuthenticatedUser } = require('../utils/auth');

const db = admin.firestore();

// ==================================================================
// 1. [API] 사용자 프로필 조회 함수
// ==================================================================
const getUserProfile = functions.runWith({ secrets: ["OPENAI_API_KEY"] }).https.onRequest((request, response) => {
    cors(request, response, async () => {
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
});

// ==================================================================
// 2. [API] 사용자 프로필 생성/업데이트 함수
// ==================================================================
const createUserProfile = functions.runWith({ secrets: ["OPENAI_API_KEY"] }).https.onRequest((request, response) => {
    cors(request, response, async () => {
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

            /*
             * readingProfile 데이터 구조 예시:
             * {
             *   "sentence": 1,    // 0: 사용 안 함, 1: 1단계, 2: 2단계
             *   "vocabulary": 2   // 0: 사용 안 함, 1: 1단계, 2: 2단계, 3: 3단계
             * }
             */
            const profileData = {
                readingProfile: readingProfile,
                knownTopics: knownTopics,
                email: user.email,
                displayName: user.name || null,
                getRecommendations: true, // 추천 기능 활성화 여부
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
});

// ==================================================================
// 3. [API] 추천 활성화/비활성화 설정 함수
// ==================================================================
const updateRecommendationSettings = functions.https.onRequest((request, response) => {
    cors(request, response, async () => {
        if (request.method !== 'POST') {
            return response.status(405).send('Only POST requests are allowed.');
        }

        try {
            const user = await getAuthenticatedUser(request);
            const userId = user.uid;
            const { getRecommendations } = request.body;

            if (typeof getRecommendations !== 'boolean') {
                return response.status(400).send('Invalid "getRecommendations" value.');
            }

            const userProfileRef = db.collection('users').doc(userId);
            await userProfileRef.update({
                getRecommendations: getRecommendations,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            response.status(200).json({
                status: 'success',
                message: 'Recommendation settings updated successfully.',
                settings: {
                    getRecommendations: getRecommendations
                }
            });
        } catch (error) {
            if (error.message.includes('토큰')) {
                response.status(401).json({ status: "error", message: error.message });
            } else {
                response.status(500).json({ status: "error", message: "서버 내부 오류", details: error.message });
            }
        }
    });
});


module.exports = {
    getUserProfile,
    createUserProfile,
    updateRecommendationSettings
};
