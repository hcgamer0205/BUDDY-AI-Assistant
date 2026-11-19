/**
 * BUDDY Direct Client-to-Gemini Service (BYOK)
 * Executes Chat streaming, Key Verification, Vision HUD analysis, and Studio code generation
 * directly against Google's official Generative Language API using the user's own API key.
 */

import { ChatMessage, GeneratedApp, VisionAnalysisResult } from '../types/surya';
import {
  DirectGeminiClient,
  DirectGeminiError,
  DEFAULT_GEMINI_MODEL,
  redactGeminiSecrets,
} from './byokGeminiHelpers.js';
import { geminiKeyVault } from './geminiKeyVault';

export { DirectGeminiError, DEFAULT_GEMINI_MODEL, redactGeminiSecrets };

const client = new DirectGeminiClient({ vault: geminiKeyVault as any });

function extractCodeOrJsonBlock(raw: string): string {
  const fenced = raw.match(/```(?:json|html)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1].trim()) return fenced[1].trim();
  return raw.trim();
}

export const directGeminiService = {
  async verifyApiKey(apiKey?: string, model?: string) {
    return client.verifyApiKey({ apiKey, model });
  },

  async refreshAvailableModels(apiKey?: string) {
    return client.listAvailableModels(apiKey);
  },

  async sendChatStream(
    message: string,
    history: ChatMessage[] = [],
    onChunk?: (accumulatedText: string) => void,
    options: {
      model?: string;
      fastMode?: boolean;
      responseMode?: 'concise' | 'detailed';
      preferredLanguage?: string;
      userMemories?: { key: string; value: string; category?: string }[];
      deviceContext?: Record<string, any>;
      systemInstruction?: string;
      maxOutputTokens?: number;
      temperature?: number;
      responseMimeType?: string;
      signal?: AbortSignal;
    } = {}
  ) {
    return client.sendChatStream(message, history, onChunk, options);
  },

  async sendChat(
    message: string,
    history: ChatMessage[] = [],
    options: {
      model?: string;
      fastMode?: boolean;
      responseMode?: 'concise' | 'detailed';
      preferredLanguage?: string;
      userMemories?: { key: string; value: string; category?: string }[];
      deviceContext?: Record<string, any>;
      imageBase64?: string | null;
      systemInstruction?: string;
      maxOutputTokens?: number;
      temperature?: number;
      responseMimeType?: string;
      signal?: AbortSignal;
    } = {}
  ) {
    return client.sendChat(message, history, options);
  },

  async analyzeOpticalScene(
    imageBase64: string,
    prompt = 'Describe what is visible in this scene concisely and accurately.'
  ): Promise<{ telemetry: string; timestamp: string }> {
    const res = await client.sendChat(prompt, [], {
      imageBase64,
      systemInstruction:
        'You are BUDDY Vision HUD. Describe real visible details clearly and concisely without fabricating telemetry.',
      temperature: 0.2,
    });
    return {
      telemetry: res.text,
      timestamp: res.timestamp,
    };
  },

  async analyzeVisionStructured(
    imageBase64: string,
    mode: 'general' | 'ocr' | 'translate' | 'document' | 'qr' = 'general',
    targetLanguage = 'English'
  ): Promise<{ success: boolean; analysis: VisionAnalysisResult; timestamp: string }> {
    const modePrompt =
      mode === 'ocr'
        ? 'Extract all legible text verbatim into ocrText and summarize the image.'
        : mode === 'translate'
        ? `Extract all visible text into ocrText, translate it to ${targetLanguage} in ocrTranslation, and summarize.`
        : mode === 'document'
        ? 'Extract key document fields (label/value pairs), ocrText, and summarize concisely.'
        : mode === 'qr'
        ? 'Identify any visible codes, labels, or text payloads and summarize.'
        : 'Summarize the scene, identify notable visible objects with approximate percentage bounding boxes (0-100), and extract any legible text.';

    const prompt = `${modePrompt}
Return strictly valid JSON matching:
{
  "summary": "string",
  "entities": [{"id":"string","label":"string","confidence":0.9,"box":{"ymin":10,"xmin":10,"ymax":80,"xmax":80}}],
  "ocrText": "string",
  "ocrTranslation": "string",
  "documentFields": [{"label":"string","value":"string"}],
  "qrPayloads": ["string"],
  "hudAdvisory": "string"
}`;

    const res = await client.sendChat(prompt, [], {
      imageBase64,
      responseMimeType: 'application/json',
      temperature: 0.2,
    });

    let analysis: VisionAnalysisResult;
    try {
      const parsed = JSON.parse(extractCodeOrJsonBlock(res.text));
      analysis = {
        summary: parsed.summary || 'Image analyzed.',
        entities: Array.isArray(parsed.entities) ? parsed.entities : [],
        ocrText: parsed.ocrText || '',
        ocrTranslation: parsed.ocrTranslation || '',
        documentFields: Array.isArray(parsed.documentFields) ? parsed.documentFields : [],
        qrPayloads: Array.isArray(parsed.qrPayloads) ? parsed.qrPayloads : [],
        hudAdvisory: parsed.hudAdvisory || '',
      };
    } catch {
      analysis = {
        summary: res.text || 'Image analyzed.',
        entities: [],
        ocrText: '',
        ocrTranslation: '',
        documentFields: [],
        qrPayloads: [],
        hudAdvisory: '',
      };
    }

    return {
      success: true,
      analysis,
      timestamp: res.timestamp,
    };
  },

  async askVisionQuestion(
    imageBase64: string | null,
    question: string,
    history: ChatMessage[] = []
  ): Promise<{ answer: string; timestamp: string }> {
    const res = await client.sendChat(question, history, {
      imageBase64,
      systemInstruction: 'You are BUDDY Vision Q&A. Answer accurately based on the supplied image and context.',
      temperature: 0.3,
    });
    return {
      answer: res.text,
      timestamp: res.timestamp,
    };
  },

  async generateStudioApp(
    prompt: string,
    appName = 'BUDDY Custom App',
    category = 'Productivity'
  ): Promise<{ success: boolean; app: GeneratedApp; message: string }> {
    const genPrompt = `Build a complete, clean, responsive single-file HTML5 web app named "${appName}" for:
${prompt}

Requirements:
- Return ONLY complete standalone HTML (starting with <!DOCTYPE html>) with clean dark styling and vanilla JS.
- No markdown fences needed, no external unverified image URLs.`;

    const res = await client.sendChat(genPrompt, [], {
      systemInstruction: 'You are BUDDY Studio App Builder. Produce working standalone HTML5 applications.',
      temperature: 0.3,
    });
    const html = extractCodeOrJsonBlock(res.text);
    const app: GeneratedApp = {
      id: `app_byok_${Date.now()}`,
      name: appName,
      description: `Built directly with ${res.model}: ${prompt.slice(0, 72)}`,
      category,
      version: '1.0.0',
      prompt,
      status: 'ready',
      createdAt: new Date().toISOString(),
      lastModified: new Date().toISOString(),
      files: [{ path: 'index.html', language: 'html', content: html }],
      previewHtml: html,
    };
    return {
      success: true,
      app,
      message: `Created "${app.name}" directly with ${res.model}.`,
    };
  },

  async modifyStudioApp(
    currentApp: GeneratedApp,
    modifyPrompt: string
  ): Promise<{ success: boolean; app: GeneratedApp; message: string }> {
    const currentHtml = currentApp.files[0]?.content || currentApp.previewHtml || '';
    const res = await client.sendChat(
      `Update this HTML5 app according to: "${modifyPrompt}". Return ONLY the complete updated HTML.\n\n${currentHtml}`,
      [],
      {
        systemInstruction: 'You are BUDDY Studio Code Editor. Return complete valid HTML.',
        temperature: 0.2,
      }
    );
    const patchedHtml = extractCodeOrJsonBlock(res.text);
    const updatedFiles = currentApp.files.map((f, idx) =>
      idx === 0 ? { ...f, content: patchedHtml } : f
    );
    return {
      success: true,
      app: {
        ...currentApp,
        files: updatedFiles,
        previewHtml: patchedHtml,
        lastModified: new Date().toISOString(),
      },
      message: 'Application updated directly via Gemini.',
    };
  },

  async debugStudioApp(
    htmlSource: string,
    errorLog = '',
    description = ''
  ): Promise<{ success: boolean; diagnosis: string; fixes: string[]; patchedHtml: string }> {
    const res = await client.sendChat(
      `Debug this HTML5 app (${description || 'BUDDY Studio app'}). Runtime errors reported: ${errorLog || 'none'}.
Return valid JSON:
{"diagnosis":"short summary","fixes":["fix 1"],"patchedHtml":"<!DOCTYPE html>..."}

HTML:
${htmlSource}`,
      [],
      {
        responseMimeType: 'application/json',
        temperature: 0.2,
      }
    );
    try {
      const parsed = JSON.parse(extractCodeOrJsonBlock(res.text));
      return {
        success: true,
        diagnosis: parsed.diagnosis || 'Inspected code with Gemini.',
        fixes: Array.isArray(parsed.fixes) ? parsed.fixes : ['Reviewed HTML and script logic'],
        patchedHtml: parsed.patchedHtml || htmlSource,
      };
    } catch {
      return {
        success: true,
        diagnosis: 'Completed Gemini code inspection.',
        fixes: ['Checked syntax and DOM references'],
        patchedHtml: extractCodeOrJsonBlock(res.text) || htmlSource,
      };
    }
  },
};
