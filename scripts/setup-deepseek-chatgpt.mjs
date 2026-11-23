import { startChatGPTSignIn } from '../benchmarking/deepseek/chatgpt-auth.mjs';
const connection = await startChatGPTSignIn();
console.log('Continue with ChatGPT:', connection.url);
console.log('Approve ChatGPT plan usage in your browser. No OpenAI API key is needed.');
try { const session = await connection.done; console.log('Connected:', session.email || 'ChatGPT account', '— ChatGPT plan usage enabled.'); }
catch (error) { console.error(error.message); process.exitCode = 1; }
finally { connection.close(); }
