const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
// 구글 클라우드 등에서 포트를 자동으로 잡아주거나, 없으면 3000번 사용
const PORT = process.env.PORT || 3000;

// [1] NVIDIA 설정 (기존 것 유지)
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// [2] Gemini 설정 (새로 추가됨)
// ⭐ 중요: 서버 환경변수에 GEMINI_API_KEY를 꼭 추가해야 합니다!
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

const SHOW_REASONING = false;
const ENABLE_THINKING_MODE = false;

// 용량 제한 설정 (파일 전송 등 고려하여 50mb로 넉넉하게)
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
  'gemini-pro': 'deepseek-ai/deepseek-r1'
};

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'OpenAI to NVIDIA NIM & Google Gemini Proxy',
    port: PORT
  });
});

app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model,
    object: 'model',
    created: Date.now(),
    owned_by: 'nvidia-nim-proxy'
  }));
  res.json({ object: 'list', data: models });
});

// ==========================================
// 🚪 문 1: 기존 NVIDIA 전용 (주소: /v1/chat/completions)
// ==========================================
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;
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
    console.error('NVIDIA Proxy error:', error.message);
    if (error.response) {
        console.error('Error data:', JSON.stringify(error.response.data).substring(0, 200));
    }
    res.status(error.response?.status || 500).json({ error: { message: error.message } });
  }
});

// ==========================================
// 🚪 문 2: 새로 만든 Gemini 전용 (주소: /gemini/chat/completions)
// ==========================================
app.post('/gemini/chat/completions', async (req, res) => {
    // 키가 없으면 에러
    if (!GEMINI_API_KEY) {
        console.error("오류: 환경변수에 GEMINI_API_KEY가 없습니다.");
        return res.status(500).json({ error: "Server Configuration Error: Gemini API Key missing" });
    }

    try {
        console.log("🚀 Gemini 요청 도착! 변환 시작...");

        // 요청 내용 복사
        const newBody = { ...req.body };

        // ✂️ [핵심] Gemini가 싫어하는 설정(repetition_penalty) 삭제
        if (newBody.repetition_penalty) {
            console.log(`✂️ 호환되지 않는 설정 제거: repetition_penalty (${newBody.repetition_penalty})`);
            delete newBody.repetition_penalty;
        }

        // 구글로 전송 (스트리밍 설정)
        const response = await axios.post(GEMINI_URL, newBody, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${GEMINI_API_KEY}`
            },
            responseType: 'stream', 
            maxBodyLength: Infinity,
            maxContentLength: Infinity
        });

        // 받은 답변을 Janitor로 토스
        response.data.pipe(res);

    } catch (error) {
        console.error("❌ Gemini Proxy 에러:", error.message);
        if (error.response) {
            // 구글에서 에러 메시지를 보냈으면 그대로 전달하려고 시도
            res.status(error.response.status).end(); 
        } else {
            res.status(500).send({ error: "Proxy Server Error" });
        }
    }
});

// 그 외 주소 처리
app.all('*', (req, res) => {
  res.status(404).json({ error: { message: `Endpoint ${req.path} not found` } });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`);
});
