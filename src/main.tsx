import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// No StrictMode: its dev-mode double-mount would open the Gemini Live
// session and microphone twice.
createRoot(document.getElementById('root')!).render(<App />);
