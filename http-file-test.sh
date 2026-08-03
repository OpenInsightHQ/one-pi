#!/bin/bash
BASE_URL="http://localhost:3000"
USER_ID="test-user"
AGENT_ID="agent-001"
SESSION_ID="session-001"
API_KEY="${PI_API_KEY:?Set PI_API_KEY env var (must match the server's PI_API_KEY)}"

echo "=== 1. Create test folder ==="
curl -s -X POST "$BASE_URL/files/mkdir" \
  -H "X-User-Id: $USER_ID" \
  -H "api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"agentId\":\"$AGENT_ID\",\"sessionId\":\"$SESSION_ID\",\"path\":\"test_folder\"}"

echo -e "\n=== 2. List files ==="
curl -s -X GET "$BASE_URL/files?agentId=$AGENT_ID&sessionId=$SESSION_ID" \
  -H "X-User-Id: $USER_ID"   -H "api-key: $API_KEY" 

echo -e "\n=== 3. Create test file ==="
echo "Hello World" > /tmp/test.txt
curl -s -X POST "$BASE_URL/upload" \
  -H "X-User-Id: $USER_ID" \
  -H "api-key: $API_KEY" \
  -F "agentId=$AGENT_ID" \
  -F "sessionId=$SESSION_ID" \
  -F "file=@/tmp/test.txt"

echo -e "\n=== 4. Search files ==="
curl -s -X GET "$BASE_URL/files/search?agentId=$AGENT_ID&sessionId=$SESSION_ID&pattern=test" \
  -H "X-User-Id: $USER_ID" \
  -H "api-key: $API_KEY"

echo -e "\n=== 5. Delete file ==="
curl -s -X DELETE "$BASE_URL/files" \
  -H "X-User-Id: $USER_ID" \
  -H "api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"agentId\":\"$AGENT_ID\",\"sessionId\":\"$SESSION_ID\",\"path\":\"test.txt\"}"

echo -e "\n=== Done ==="
rm -f /tmp/test.txt