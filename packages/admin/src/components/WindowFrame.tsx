import React from 'react';

interface WindowFrameProps {
  title: string;
  children: React.ReactNode;
  width?: string;
  height?: string;
  onClose?: () => void;
  onMinimize?: () => void;
  isDark?: boolean;
  frameless?: boolean;
}

export const WindowFrame: React.FC<WindowFrameProps> = ({ 
  title, 
  children, 
  width = "max-w-4xl", 
  height = "h-[600px]",
  onClose,
  onMinimize,
  isDark = false,
  frameless = false
}) => {
  const containerBase = frameless
    ? `relative flex flex-col w-full h-full bg-white`
    : `relative flex flex-col ${width} ${height} rounded-xl shadow-2xl overflow-hidden border ${isDark ? 'border-gray-700 bg-gray-900' : 'border-gray-200 bg-white'} transition-all duration-300`;

  return (
    <div className={containerBase}>
      {!frameless && (
        <div className={`flex items-center justify-between px-4 py-3 ${isDark ? 'bg-gray-800 text-gray-200' : 'bg-gray-50 text-gray-700'} border-b ${isDark ? 'border-gray-700' : 'border-gray-200'} select-none`}>
          <div className="flex items-center gap-2 text-sm font-semibold tracking-wide">
            <div className="w-5 h-5 bg-indigo-600 rounded flex items-center justify-center text-white text-[9px] font-bold shadow-sm">WR</div>
            {title}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onMinimize} className={`p-1.5 hover:${isDark ? 'bg-gray-700' : 'bg-gray-200'} rounded transition-colors`}>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
              </svg>
            </button>
            <button className={`p-1.5 hover:${isDark ? 'bg-gray-700' : 'bg-gray-200'} rounded transition-colors opacity-50 cursor-default`}>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4h16v16H4z" />
              </svg>
            </button>
            <button onClick={onClose} className="p-1.5 hover:bg-red-500 hover:text-white rounded transition-colors">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}
      
      <div className="flex-1 overflow-auto relative">
        {children}
      </div>
    </div>
  );
};
