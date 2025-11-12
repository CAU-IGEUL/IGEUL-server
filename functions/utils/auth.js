// functions/utils/auth.js
const admin = require('firebase-admin');

/**
 * (헬퍼 함수) 요청 헤더에서 ID 토큰을 추출하고 검증하여 사용자 정보를 반환
 */
const getAuthenticatedUser = async (request) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new Error('인증 토큰이 없습니다. (No token)');
    }
    const idToken = authHeader.split('Bearer ')[1];

    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        return decodedToken; // { uid, email, ... } 등이 포함된 객체 반환
    } catch (error) {
        console.error("토큰 검증 실패:", error);
        throw new Error('유효하지 않은 토큰입니다. (Invalid token)');
    }
};

module.exports = {
    getAuthenticatedUser
};
