const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// [1] 환경변수 로드
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

const ENABLE_THINKING_MODE = false;

// 용량 제한 해제
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors());

// 모델 매핑 (NVIDIA용)
const MODEL_MAPPING = {
  'gpt-4o': 'meta/llama-3.1-405b-instruct',
  'gpt-4': 'deepseek-ai/deepseek-v3.1-terminus',
  'gpt-4-turbo': 'deepseek-ai/deepseek-r1-0528',
  'gpt-3.5-turbo': 'meta/llama-3.1-70b-instruct',
  'claude-3-opus': 'meta/llama-3.1-405b-instruct',
  // Gemini는 매핑 없이 통과
};

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Dual AI Proxy', port: PORT });
});

app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(id => ({ id, object: 'model' }));
  models.push({ id: 'gemini-1.5-flash', object: 'model' });
  models.push({ id: 'gemini-1.5-pro', object: 'model' });
  res.json({ object: 'list', data: models });
});

// ==========================================
// 🚀 통합 엔드포인트
// ==========================================
app.post('/v1/chat/completions', async (req, res) => {
  const { model, messages, temperature, max_tokens, stream } = req.body;

  // -------------------------------------------------------
  // [A] Gemini 처리 구간 (모델명에 'gemini'가 있을 때)
  // -------------------------------------------------------
  if (model && model.toLowerCase().includes('gemini')) {
    if (!GEMINI_API_KEY) return res.status(500).json({ error: "Gemini Key Missing" });

    try {
      console.log(`🔹 Gemini 요청: ${model}`);
      const newBody = { ...req.body };
      if (newBody.repetition_penalty) delete newBody.repetition_penalty;

      const response = await axios.post(GEMINI_URL, newBody, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GEMINI_API_KEY}`
        },
        responseType: 'stream'
      });

      // Gemini 스트리밍 헤더 설정
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      return response.data.pipe(res);

    } catch (error) {
      console.error("Gemini Error:", error.message);
      return res.status(500).json({ error: error.message });
    }
  }

  // -------------------------------------------------------
  // [B] NVIDIA (DeepSeek) 처리 구간 (기존 로직 100% 복구)
  // -------------------------------------------------------
  try {
    let nimModel = MODEL_MAPPING[model] || 'meta/llama-3.1-405b-instruct';
    
    // [중요] 작가님 기존 설정 그대로 적용
    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature || 0.6,
      max_tokens: max_tokens || 1024,
      extra_body: ENABLE_THINKING_MODE ? { chat_template_kwargs: { thinking: true } } : undefined,
      stream: stream || false
    };

    console.log(`🔸 NVIDIA 요청: ${nimModel}`);

    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json',
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });

    // 🚨 [복구된 핵심 부분] Janitor가 기다리지 않게 헤더 강제 설정
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      response.data.pipe(res);
    } else {
      res.json(response.data);
    }

  } catch (error) {
    console.error('NVIDIA Proxy Error:', error.message);
    if (error.response) {
       // 에러 내용 상세 출력 (디버깅용)
       console.error('Data:', JSON.stringify(error.response.data).substring(0, 200));
       res.status(error.response.status).send(error.response.data);
    } else {
       res.status(500).json({ error: { message: error.message } });
    }
  }
});

app.all('*', (req, res) => {
  res.status(404).json({ error: { message: "Not Found" } });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
