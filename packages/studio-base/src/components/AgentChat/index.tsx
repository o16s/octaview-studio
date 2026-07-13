// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import SendIcon from "@mui/icons-material/Send";
import {
  CircularProgress,
  IconButton,
  InputAdornment,
  LinearProgress,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { makeStyles } from "tss-react/mui";

import { MessageEvent } from "@foxglove/studio";
import { AppSetting } from "@foxglove/studio-base/AppSetting";
import {
  MessagePipelineContext,
  useMessagePipeline,
} from "@foxglove/studio-base/components/MessagePipeline";
import Stack from "@foxglove/studio-base/components/Stack";
import { useCurrentLayoutActions } from "@foxglove/studio-base/context/CurrentLayoutContext";
import { usePanelCatalog } from "@foxglove/studio-base/context/PanelCatalogContext";
import { usePlayerSelection } from "@foxglove/studio-base/context/PlayerSelectionContext";
import { useAppConfigurationValue } from "@foxglove/studio-base/hooks";

import AgentAvatarSvg from "./agent-avatar.svg";
import { ExecuteToolFn, runAgentLoop } from "./agentLoop";
import { createRemoteProvider, createWebLLMProvider } from "./completionProvider";
import { parseMarkdown } from "./parseMarkdown";
import { initWebLLMEngine, unloadWebLLMEngine, getWebLLMStatus, subscribeWebLLMStatus, WebLLMStatus } from "./webllmEngine";
import { buildSystemPrompt } from "./systemPrompt";
import { TOOL_DEFINITIONS } from "./toolDefinitions";
import { Incident, createToolExecutor, StudioContext } from "./toolExecutor";
import { ChatMessage } from "./types";

const useStyles = makeStyles()((theme) => ({
  container: {
    height: "100%",
    display: "flex",
    flexDirection: "column",
  },
  messages: {
    flex: 1,
    overflowY: "auto",
    padding: theme.spacing(1),
    gap: theme.spacing(1),
    display: "flex",
    flexDirection: "column",
  },
  bubble: {
    padding: theme.spacing(1, 1.5),
    borderRadius: theme.shape.borderRadius,
    maxWidth: "90%",
    whiteSpace: "pre-wrap",
    fontSize: theme.typography.body2.fontSize,
    lineHeight: 1.5,
  },
  userBubble: {
    alignSelf: "flex-end",
    backgroundColor: theme.palette.primary.main,
    color: theme.palette.primary.contrastText,
  },
  assistantBubble: {
    alignSelf: "flex-start",
    backgroundColor: theme.palette.action.hover,
    "& table": {
      borderCollapse: "collapse",
      margin: theme.spacing(0.5, 0),
      fontSize: "0.8rem",
    },
    "& th, & td": {
      border: `1px solid ${theme.palette.divider}`,
      padding: theme.spacing(0.25, 0.75),
      textAlign: "left",
    },
    "& th": {
      fontWeight: 600,
      backgroundColor: theme.palette.action.selected,
    },
    "& ul": {
      margin: theme.spacing(0.5, 0),
      paddingLeft: theme.spacing(2),
    },
  },
  assistantRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: theme.spacing(1),
  },
  avatar: {
    width: 24,
    height: 24,
    borderRadius: "50%",
    flexShrink: 0,
    marginTop: 2,
  },
  inputArea: {
    borderTop: `1px solid ${theme.palette.divider}`,
    padding: theme.spacing(1),
  },
  placeholder: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    padding: theme.spacing(2),
    textAlign: "center",
  },
}));

const selectTopics = (ctx: MessagePipelineContext) => ctx.sortedTopics;
const selectDatatypes = (ctx: MessagePipelineContext) => ctx.datatypes;
const selectSeekPlayback = (ctx: MessagePipelineContext) => ctx.seekPlayback;
const selectBlocks = (ctx: MessagePipelineContext) =>
  ctx.playerState.progress?.messageCache?.blocks;
const selectStartTime = (ctx: MessagePipelineContext) =>
  ctx.playerState.activeData?.startTime;


// Persist chat state across sidebar tab switches (component unmount/remount)
let persistedMessages: ChatMessage[] = [];
let persistedInput = "";

export default function AgentChat(): ReactElement {
  const { classes, cx } = useStyles();
  const [messages, setMessages] = useState<ChatMessage[]>(persistedMessages);
  const [input, setInput] = useState(persistedInput);
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => { persistedMessages = messages; }, [messages]);
  useEffect(() => { persistedInput = input; }, [input]);

  const [backend] = useAppConfigurationValue<string>(AppSetting.AGENT_BACKEND);
  const [apiEndpoint] = useAppConfigurationValue<string>(AppSetting.AGENT_API_ENDPOINT);
  const [apiKey] = useAppConfigurationValue<string>(AppSetting.AGENT_API_KEY);
  const [model] = useAppConfigurationValue<string>(AppSetting.AGENT_MODEL);
  const [webllmModel] = useAppConfigurationValue<string>(AppSetting.AGENT_WEBLLM_MODEL);
  const [webllmCtxSize] = useAppConfigurationValue<number>(AppSetting.AGENT_WEBLLM_CTX_SIZE);
  const [webllmStatus, setWebllmStatus] = useState<WebLLMStatus>(getWebLLMStatus);

  useEffect(() => {
    return subscribeWebLLMStatus(setWebllmStatus);
  }, []);

  const topics = useMessagePipeline(selectTopics);
  const datatypes = useMessagePipeline(selectDatatypes);
  const seekPlayback = useMessagePipeline(selectSeekPlayback);
  const blocks = useMessagePipeline(selectBlocks);
  const startTime = useMessagePipeline(selectStartTime);
  const panelCatalog = usePanelCatalog();
  const { selectSource } = usePlayerSelection();
  const { addPanel, changePanelLayout, savePanelConfigs, setCurrentLayout, getCurrentLayoutState } =
    useCurrentLayoutActions();

  const panelTypes = useMemo(
    () => panelCatalog.getPanels().map((p) => p.type),
    [panelCatalog],
  );

  const incidents = useMemo((): Incident[] => {
    if (typeof window === "undefined") return [];
    const incParam = new URLSearchParams(window.location.search).get("incidents");
    if (!incParam) return [];
    try {
      return JSON.parse(atob(incParam)) as Incident[];
    } catch {
      try {
        return JSON.parse(incParam) as Incident[];
      } catch {
        return [];
      }
    }
  }, []);

  const getBlockMessages = useCallback(
    (topic: string): MessageEvent[] => {
      if (!blocks) return [];
      const result: MessageEvent[] = [];
      for (const block of blocks) {
        if (!block) continue;
        const topicMessages = block.messagesByTopic[topic];
        if (topicMessages) {
          for (const msg of topicMessages) {
            result.push(msg);
          }
        }
      }
      return result;
    },
    [blocks],
  );

  const studioContext = useMemo((): StudioContext => {
    const layoutState = getCurrentLayoutState();
    const data = layoutState.selectedLayout?.data;
    return {
      topics: topics.map((t) => ({ name: t.name, schemaName: t.schemaName })),
      datatypes,
      panelTypes,
      currentLayout: {
        layout: data?.layout,
        configById: data?.configById ?? {},
      },
      addPanel,
      changePanelLayout,
      savePanelConfigs,
      setCurrentLayout: (data) => {
        const layoutState = getCurrentLayoutState();
        const existingData = layoutState.selectedLayout?.data;
        setCurrentLayout({
          data: {
            configById: data.configById as Record<string, Record<string, unknown>>,
            layout: data.layout,
            globalVariables: existingData?.globalVariables ?? {},
            userNodes: existingData?.userNodes ?? {},
            playbackConfig: existingData?.playbackConfig ?? { speed: 1 },
          },
        });
      },
      seekPlayback,
      selectSource,
      getBlockMessages,
      incidents,
      startTime,
    };
  }, [topics, datatypes, panelTypes, getCurrentLayoutState, addPanel, changePanelLayout, savePanelConfigs, setCurrentLayout, seekPlayback, selectSource, getBlockMessages, incidents, startTime]);

  // Keep a ref so tool calls mid-loop always see the latest context
  const studioContextRef = useRef(studioContext);
  studioContextRef.current = studioContext;

  // Unload WebLLM engine when switching away from webllm backend to free GPU memory
  const prevBackendRef = useRef(backend);
  useEffect(() => {
    if (prevBackendRef.current === "webllm" && backend !== "webllm") {
      unloadWebLLMEngine();
    }
    prevBackendRef.current = backend;
  }, [backend]);

  const handleClear = useCallback(() => {
    setMessages([]);
    persistedMessages = [];
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    const isRemote = backend !== "webllm";
    if (isRemote && (!apiEndpoint || !apiKey || !model)) return;
    if (!isRemote && !webllmModel) return;

    const userMessage: ChatMessage = { role: "user", content: trimmed };
    const systemMessage: ChatMessage = {
      role: "system",
      content: buildSystemPrompt(panelTypes),
    };

    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setInput("");
    setLoading(true);

    try {
      let completionProvider;
      if (isRemote) {
        completionProvider = createRemoteProvider(fetch, apiEndpoint!, apiKey!, model!);
      } else {
        const engine = await initWebLLMEngine(webllmModel!, webllmCtxSize);
        completionProvider = createWebLLMProvider(engine);
      }

      const conversationWithSystem = [systemMessage, ...updatedMessages];
      // Each tool call creates a fresh executor from the ref so it sees the latest context
      const executeTool: ExecuteToolFn = async (name, args) =>
        createToolExecutor(studioContextRef.current)(name, args);

      const result = await runAgentLoop({
        messages: conversationWithSystem,
        tools: TOOL_DEFINITIONS,
        completionProvider,
        executeTool,
      });

      // Strip system message from stored conversation
      const withoutSystem = result.messages.slice(1);
      setMessages(withoutSystem);
    } catch (err) {
      const errorMessage: ChatMessage = {
        role: "assistant",
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setLoading(false);
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- studioContextRef is intentionally read via ref to avoid stale closures
  }, [input, loading, backend, apiEndpoint, apiKey, model, webllmModel, webllmCtxSize, messages, panelTypes]);

  const isRemote = backend !== "webllm";
  const configured = isRemote ? apiEndpoint && apiKey && model : !!webllmModel;

  if (!configured) {
    return (
      <div className={classes.placeholder}>
        <Typography variant="body2" color="text.secondary">
          {isRemote
            ? "Configure the Agent in Settings \u203A General to get started. Set API endpoint, key, and model name."
            : "Select a WebLLM model in Settings \u203A General to get started."}
        </Typography>
      </div>
    );
  }

  const visibleMessages = messages.filter((m) => (m.role === "user" || m.role === "assistant") && m.content);

  return (
    <div className={classes.container}>
      <div className={classes.messages}>
        {visibleMessages.length === 0 && !loading && (
          <Typography variant="body2" color="text.secondary" sx={{ p: 2, textAlign: "center" }}>
            Ask me to set up visualizations. For example: &quot;Show me the camera feed and a plot of
            IMU acceleration side by side&quot;
          </Typography>
        )}
        {visibleMessages.map((msg, i) =>
          msg.role === "assistant" && msg.content ? (
            <div key={i} className={classes.assistantRow}>
              <AgentAvatarSvg className={classes.avatar} />
              <div
                className={cx(classes.bubble, classes.assistantBubble)}
                dangerouslySetInnerHTML={{ __html: parseMarkdown(msg.content) }}
              />
            </div>
          ) : (
            <div
              key={i}
              className={cx(classes.bubble, msg.role === "user" ? classes.userBubble : classes.assistantBubble)}
            >
              {msg.content}
            </div>
          ),
        )}
        {loading && (
          <Stack gap={0.5} paddingX={1}>
            {webllmStatus.state === "loading" && (
              <>
                <LinearProgress
                  variant={webllmStatus.progress != undefined ? "determinate" : "indeterminate"}
                  value={(webllmStatus.progress ?? 0) * 100}
                />
                <Typography variant="caption" color="text.secondary">
                  {webllmStatus.text ?? "Loading model..."}
                </Typography>
              </>
            )}
            {webllmStatus.state !== "loading" && (
              <Stack direction="row" alignItems="center" gap={1}>
                <CircularProgress size={16} />
                <Typography variant="caption" color="text.secondary">
                  Thinking...
                </Typography>
              </Stack>
            )}
          </Stack>
        )}
        <div ref={messagesEndRef} />
      </div>
      <div className={classes.inputArea}>
        <TextField
          fullWidth
          size="small"
          placeholder="Ask the agent..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          disabled={loading}
          InputProps={{
            startAdornment: messages.length > 0 && !loading ? (
              <InputAdornment position="start">
                <Tooltip title="Clear chat">
                  <IconButton size="small" onClick={handleClear}>
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </InputAdornment>
            ) : undefined,
            endAdornment: (
              <InputAdornment position="end">
                <IconButton size="small" onClick={() => void handleSend()} disabled={loading || !input.trim()}>
                  <SendIcon fontSize="small" />
                </IconButton>
              </InputAdornment>
            ),
          }}
        />
      </div>
    </div>
  );
}
