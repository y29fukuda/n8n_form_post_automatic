# n8n HTTP Request node settings

Endpoint: `{{TUNNEL_URL}}/post`

## Option A: Send Query Parameters (most robust)
- Method: POST
- URL: `{{TUNNEL_URL}}/post`
- Send Query Parameters: **ON**
  - phone    → `{{$json.phone}}`
  - comment  → `{{$json.comment}}`
  - callform → `{{$json.callform}}`
  - rating   → `{{$json.rating}}`
- Send Body: OFF

## Option B: Send JSON Body
- Method: POST
- URL: `{{TUNNEL_URL}}/post`
- Body Content Type: JSON
- Specify Body: Using JSON
- JSON:
  ```json
  {
    "phone": "{{$json.phone}}",
    "comment": "{{$json.comment}}",
    "callform": "{{$json.callform}}",
    "rating": {{$json.rating}}
  }
  ```
- (Header) Content-Type: application/json

> If you still see `phone is required`, open the node’s “raw request” panel and confirm `phone` is actually present in the outgoing request.
