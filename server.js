const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// [1] API 키 설정 (환경변수 필수)
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; // ⭐ 구글 키 추가 확인
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

const ENABLE_THINKING_MODE = false;

// 용량 제한 해제
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors());

// [2] 모델 매핑 (NVIDIA용) + Gemini는 그대로 통과
const MODEL_MAPPING = {
  'gpt-4o': 'meta/llama-3.1-405b-instruct',
  'gpt-4': 'deepseek-ai/deepseek-v3.1-terminus',
  'gpt-4-turbo': 'deepseek-ai/deepseek-r1-0528',
  'gpt-3.5-turbo': 'meta/llama-3.1-70b-instruct',
  'claude-3-opus': 'meta/llama-3.1-405b-instruct',
  // Gemini 모델은 매핑 없이 그대로 씁니다.
};

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Unified AI Proxy', port: PORT });
});

// 모델 리스트 반환
app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(id => ({ id, object: 'model' }));
  // Gemini 모델도 리스트에 살짝 추가해 줍니다 (편의상)
  models.push({ id: 'gemini-2.5-flash', object: 'model' });
  models.push({ id: 'gemini-2.5-pro', object: 'model' });
  res.json({ object: 'list', data: models });
});

// ==========================================
// 🚀 통합 채팅 엔드포인트 (여기서 갈림길을 만듭니다)
// ==========================================
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;
    
    // [A] Gemini 모델인지 확인 (이름에 'gemini'가 들어가는지 체크)
    if (model && model.toLowerCase().includes('gemini')) {
      
      if (!GEMINI_API_KEY) {
        return res.status(500).json({ error: "Server Error: GEMINI_API_KEY not found." });
      }

      console.log(`🔹 Gemini 요청 감지: ${model}`);

      // Janitor 요청 복사 후 'repetition_penalty' 제거 (수술)
      const newBody = { ...req.body };
      if (newBody.repetition_penalty) delete newBody.repetition_penalty;

      // 구글로 전송
      try {
        const response = await axios.post(GEMINI_URL, newBody, {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${GEMINI_API_KEY}`
          },
          responseType: 'stream'
        });
        return response.data.pipe(res); // Gemini 응답 바로 반환
      } catch (geminiError) {
        console.error("Gemini API Error:", geminiError.message);
        if (geminiError.response) {
            return res.status(geminiError.response.status).send(geminiError.response.data);
        }
        return res.status(500).json({ error: "Gemini Upstream Error" });
      }
    }

    // [B] 아니면 NVIDIA로 처리 (기존 로직)
    let nimModel = MODEL_MAPPING[model] || 'meta/llama-3.1-405b-instruct';
    
    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature || 0.6,
      max_tokens: max_tokens || 1024,
      extra_body: ENABLE_THINKING_MODE ? { chat_template_kwargs: { thinking: true } } : undefined,
      stream: stream || false
    };

    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json',
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      response.data.pipe(res);
    } else {
      res.json(response.data);
    }

  } catch (error) {
    console.error('General Proxy Error:', error.message);
    res.status(500).json({ error: { message: error.message } });
  }
});

app.all('*', (req, res) => {
  res.status(404).json({ error: { message: `Path ${req.path} not found. Use /v1/chat/completions` } });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`통합 서버 가동 중: Port ${PORT}`);
});
