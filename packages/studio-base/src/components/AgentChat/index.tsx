// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import SendIcon from "@mui/icons-material/Send";
import {
  CircularProgress,
  IconButton,
  InputAdornment,
  TextField,
  Typography,
} from "@mui/material";
import { ReactElement, useCallback, useMemo, useRef, useState } from "react";
import { makeStyles } from "tss-react/mui";

import { AppSetting } from "@foxglove/studio-base/AppSetting";
import {
  MessagePipelineContext,
  useMessagePipeline,
} from "@foxglove/studio-base/components/MessagePipeline";
import Stack from "@foxglove/studio-base/components/Stack";
import { useCurrentLayoutActions } from "@foxglove/studio-base/context/CurrentLayoutContext";
import { usePanelCatalog } from "@foxglove/studio-base/context/PanelCatalogContext";
import { useAppConfigurationValue } from "@foxglove/studio-base/hooks";

import AgentAvatarSvg from "./agent-avatar.svg";
import { runAgentLoop } from "./agentLoop";
import { parseMarkdown } from "./parseMarkdown";
import { buildSystemPrompt } from "./systemPrompt";
import { TOOL_DEFINITIONS } from "./toolDefinitions";
import { createToolExecutor, StudioContext } from "./toolExecutor";
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


export default function AgentChat(): ReactElement {
  const { classes, cx } = useStyles();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const [apiEndpoint] = useAppConfigurationValue<string>(AppSetting.AGENT_API_ENDPOINT);
  const [apiKey] = useAppConfigurationValue<string>(AppSetting.AGENT_API_KEY);
  const [model] = useAppConfigurationValue<string>(AppSetting.AGENT_MODEL);

  const topics = useMessagePipeline(selectTopics);
  const datatypes = useMessagePipeline(selectDatatypes);
  const panelCatalog = usePanelCatalog();
  const { addPanel, changePanelLayout, savePanelConfigs, getCurrentLayoutState } =
    useCurrentLayoutActions();

  const panelTypes = useMemo(
    () => panelCatalog.getPanels().map((p) => p.type),
    [panelCatalog],
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
    };
  }, [topics, datatypes, panelTypes, getCurrentLayoutState, addPanel, changePanelLayout, savePanelConfigs]);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || loading) return;
    if (!apiEndpoint || !apiKey || !model) return;

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
      const conversationWithSystem = [systemMessage, ...updatedMessages];
      const executeTool = createToolExecutor(studioContext);

      const result = await runAgentLoop({
        messages: conversationWithSystem,
        tools: TOOL_DEFINITIONS,
        fetchFn: fetch,
        executeTool,
        apiEndpoint,
        apiKey,
        model,
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
  }, [input, loading, apiEndpoint, apiKey, model, messages, panelTypes, studioContext]);

  const configured = apiEndpoint && apiKey && model;

  if (!configured) {
    return (
      <div className={classes.placeholder}>
        <Typography variant="body2" color="text.secondary">
          Configure the Agent in Settings &gt; General to get started.
          <br />
          Set API endpoint, key, and model name.
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
          <Stack direction="row" alignItems="center" gap={1} paddingX={1}>
            <CircularProgress size={16} />
            <Typography variant="caption" color="text.secondary">
              Thinking...
            </Typography>
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
