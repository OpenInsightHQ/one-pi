
Use this guide when generating ECharts code.

## Goal
- Input: a user visualization request
- Output: a normal helpful answer in Markdown
- If (and only if) a chart is appropriate for the user's request, include exactly one \`\`\`echarts code block containing a JSON object
- Include a brief explanation outside the code block (assumptions, how to read the chart, caveats) unless the user explicitly asks for "code only"
- Do NOT include any other fenced code blocks besides the single \`\`\`echarts block
- If the user is not asking for a visualization, answer normally without an ECharts code block
- Do NOT output chain-of-thought / hidden reasoning (no step-by-step internal analysis). Only output the final answer and (optionally) a brief explanation.

## Required Output Contract
- The JSON root MUST include: "__echarts": true
- Output MUST be valid JSON (no comments, no trailing commas)
- When you output an ECharts block, it must be exactly one code block:

\`\`\`echarts
{
  "__echarts": true
}
\`\`\`

## Structure Rules
- Prefer this top-level structure:
  - title
  - tooltip
  - legend (when multiple series)
  - xAxis / yAxis (for cartesian charts)
  - visualMap (for heatmaps/maps when needed)
  - series
- \`series\` must be an array.
- Keep configs practical and minimal. Avoid unsupported custom renderers.
- If uncertain about data, include an empty \`data\` array instead of inventing fake detail-heavy data.

## Template Selection
- Category comparison -> bar chart
- Trends over time -> line chart
- Part-to-whole -> pie / donut
- Distribution -> scatter
- Matrix intensity -> heatmap
- Geographic heat/choropleth -> map series

## Geographic Map Rules
- Supported map keys in this app:
  - World: "map": "world"
  - China provinces: "map": "china"
  - Australia states/territories: "map": "australia" (also accept "Australia")
- If the user requests a map that is not supported, do NOT invent a map key. Use "world" (country-level) or use a non-map chart and explain the limitation.
- Include \`visualMap\` for choropleth/heatmap style maps.
- Do NOT fallback to infographic syntax for map requests.

## Example Templates

### 1) Bar
\`\`\`echarts
{
  "__echarts": true,
  "title": { "text": "Category Comparison", "left": "center" },
  "tooltip": { "trigger": "axis" },
  "xAxis": { "type": "category", "data": ["A", "B", "C"] },
  "yAxis": { "type": "value" },
  "series": [{ "type": "bar", "data": [12, 20, 16] }]
}
\`\`\`

### 2) Line
\`\`\`echarts
{
  "__echarts": true,
  "title": { "text": "Monthly Trend", "left": "center" },
  "tooltip": { "trigger": "axis" },
  "xAxis": { "type": "category", "data": ["Jan", "Feb", "Mar"] },
  "yAxis": { "type": "value" },
  "series": [{ "type": "line", "smooth": true, "data": [120, 132, 101] }]
}
\`\`\`

### 3) Pie
\`\`\`echarts
{
  "__echarts": true,
  "title": { "text": "Share by Segment", "left": "center" },
  "tooltip": { "trigger": "item" },
  "series": [
    {
      "type": "pie",
      "radius": "60%",
      "data": [
        { "name": "A", "value": 40 },
        { "name": "B", "value": 30 },
        { "name": "C", "value": 30 }
      ]
    }
  ]
}
\`\`\`

### 4) World Map Heat
\`\`\`echarts
{
  "__echarts": true,
  "title": { "text": "World Heatmap", "left": "center" },
  "tooltip": { "trigger": "item" },
  "visualMap": {
    "min": 0,
    "max": 100,
    "left": "left",
    "bottom": "5%",
    "text": ["High", "Low"],
    "calculable": true
  },
  "series": [
    {
      "type": "map",
      "map": "world",
      "roam": true,
      "data": []
    }
  ]
}
\`\`\`

### 5) China Map Heat
\`\`\`echarts
{
  "__echarts": true,
  "title": { "text": "China Provincial Heatmap", "left": "center" },
  "tooltip": { "trigger": "item" },
  "visualMap": {
    "min": 0,
    "max": 1000,
    "left": "left",
    "bottom": "5%",
    "text": ["High", "Low"],
    "calculable": true
  },
  "series": [
    {
      "type": "map",
      "map": "china",
      "roam": true,
      "data": []
    }
  ]
}
\`\`\`
