import ChatBot from './components/chat/ChatBot';

export default function App() {
   return (
      <div style={{ maxWidth: 900, margin: '40px auto', padding: 16 }}>
         <h1 style={{ fontSize: 22, marginBottom: 16 }}>Chat</h1>
         <ChatBot />
      </div>
   );
}
