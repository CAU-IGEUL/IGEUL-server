// functions/utils/analysis.js

// 한국어 조사를 고려한 불용어 목록
const KOREAN_STOPWORDS = [
    '이', '가', '은', '는', '을', '를', '의', '에', '에서', '에게', '께', '한테', '로', '으로', '과', '와',
    '그리고', '그래서', '그러나', '하지만', '그런데', '또는', '및',
    '것', '수', '때', '등', '저', '저희', '그', '그녀', '우리',
    '있다', '없다', '이다', '아니다', '되다', '하다',
];

// 문장 분리 (마침표, 물음표, 느낌표 기준)
const getSentences = (text) => {
    if (!text) return [];
    // 여러 개가 붙어있는 경우를 대비해 정규식 사용, 빈 문장 제거
    return text.split(/[.?!]+/).filter(s => s.trim().length > 0);
};

// 단어 분리 (공백 기준, 구두점 제거)
const getWords = (text) => {
    if (!text) return [];
    return text.trim().replace(/[.,?!'"]/g, '').split(/\s+/).filter(w => w.length > 0);
};

// 한글 음절 수 계산 (한글 범위: 0xAC00 ~ 0xD7A3)
const getHangulSyllableCount = (text) => {
    let count = 0;
    for (let i = 0; i < text.length; i++) {
        const charCode = text.charCodeAt(i);
        if (charCode >= 0xAC00 && charCode <= 0xD7A3) {
            count++;
        }
    }
    return count;
};

// 텍스트 분석 함수
const analyzeText = (text) => {
    const sentences = getSentences(text);
    const words = getWords(text);
    const stopwordCount = words.filter(word => KOREAN_STOPWORDS.includes(word)).length;
    
    const charCount = text.length;
    const wordCount = words.length;
    const sentenceCount = sentences.length;
    const syllableCount = getHangulSyllableCount(text);

    // 0으로 나누는 경우 방지
    const avgSentenceLength = sentenceCount > 0 ? wordCount / sentenceCount : 0;
    const avgWordSyllableLength = wordCount > 0 ? syllableCount / wordCount : 0;

    // 가독성 점수 (수치가 낮을수록 읽기 쉬움)
    // Kincaid 공식을 한국어에 맞게 변형: (0.6 * 평균 문장 길이) + (0.4 * 평균 단어 음절 수)
    const readabilityScore = (0.6 * avgSentenceLength) + (0.4 * avgWordSyllableLength);

    return {
        charCount,
        wordCount,
        sentenceCount,
        syllableCount,
        stopwordCount,
        avgSentenceLength,
        avgWordSyllableLength,
        readabilityScore,
    };
};

module.exports = {
    analyzeText
};
