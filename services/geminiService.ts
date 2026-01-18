import { GoogleGenAI } from "@google/genai";

const getAIClient = () => {
  if (!process.env.API_KEY) {
    throw new Error("API Key is missing");
  }
  return new GoogleGenAI({ apiKey: process.env.API_KEY });
};

export const analyzeDeviceLogs = async (logs: string[]): Promise<string> => {
  try {
    const ai = getAIClient();
    const prompt = `
      You are a Senior IT Support Technician.
      Analyze the following system logs from a rented Windows PC and provide a brief diagnosis and suggested fix.
      Keep it professional and concise (under 3 sentences).
      
      Logs:
      ${logs.join('\n')}
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
    });

    return response.text || "Unable to analyze logs at this time.";
  } catch (error) {
    console.error("Gemini API Error:", error);
    return "Error connecting to AI diagnostic service.";
  }
};
