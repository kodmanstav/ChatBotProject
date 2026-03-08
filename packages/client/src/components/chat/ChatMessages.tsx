import { useEffect, useRef } from 'react';
import ReactMarkDown from 'react-markdown';

export type Message = {
   role: 'user' | 'bot';
   content?: string;
   json?: unknown;
};

type Props = {
   messages: Message[];
};

const ChatMessages = ({ messages }: Props) => {
   const lastMessageRef = useRef<HTMLDivElement | null>(null);

   useEffect(() => {
      lastMessageRef.current?.scrollIntoView({ behavior: 'smooth' });
   }, [messages]);

   return (
      <div className="flex flex-col gap-3">
         {messages.map((message, index) => (
            <div
               key={index}
               ref={index === messages.length - 1 ? lastMessageRef : null}
               className={`max-w-md rounded-xl px-3 py-2 ${
                  message.role === 'user'
                     ? 'self-end bg-blue-600 text-white'
                     : 'self-start bg-gray-100 text-black'
               }`}
            >
               {typeof message.content === 'string' && (
                  <ReactMarkDown>{message.content}</ReactMarkDown>
               )}

               {message.json !== undefined && (
                  <pre>{JSON.stringify(message.json, null, 2)}</pre>
               )}
            </div>
         ))}
      </div>
   );
};

export default ChatMessages;
