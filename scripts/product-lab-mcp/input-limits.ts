// Shared by the Netlify and Worker entry points; also bounds stdio tool validation.
export const MAX_MCP_REQUEST_BODY_BYTES = 256 * 1024;
export const MAX_MCP_TOOL_INPUT_ELEMENTS = 5_000;
// 500 rows with all seven fields plus source metadata fit within the element budget.
export const MAX_MCP_PHYSICAL_COUNT_ROWS = 500;
