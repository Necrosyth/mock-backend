# Mock Video Intelligence Backend

> **Base URL:** `https://mock-backend-poh8.onrender.com`

A mock server that serves a video file alongside Google Video Intelligence–style annotation data, with both REST endpoints and a real-time WebSocket stream that replays annotations in sync with video playback.

---

## Endpoints at a Glance

| Type | Path | Description |
|------|------|-------------|
| HTTP GET | `/health` | Server liveness check |
| HTTP GET | `/video` | Streaming video file (range-request capable) |
| HTTP GET | `/annotations` | Full annotation JSON dump |
| WebSocket | `/ws/stream` | Real-time annotation stream synced to video |

---

## HTTP Endpoints

### `GET /health`

Returns a simple liveness check. Use this to confirm the server is up before making other requests.

**Request**
```
GET https://mock-backend-poh8.onrender.com/health
```

**Response** `200 OK`
```json
{ "ok": true }
```

**Try it (curl)**
```bash
curl https://mock-backend-poh8.onrender.com/health
```

---

### `GET /video`

Returns the video file (`video.mp4`). Supports HTTP range requests, so it works natively with browser `<video>` elements and any media player that understands `206 Partial Content`.

**Request**
```
GET https://mock-backend-poh8.onrender.com/video
```

**Response headers (full file)**
```
Content-Type: video/mp4
Content-Length: <file size in bytes>
```

**Response headers (range request)**
```
HTTP/1.1 206 Partial Content
Content-Type: video/mp4
Content-Range: bytes <start>-<end>/<total>
Accept-Ranges: bytes
Content-Length: <chunk size>
```

**Try it (curl — download full file)**
```bash
curl -o video.mp4 https://mock-backend-poh8.onrender.com/video
```

**Try it (curl — range request, first 1 MB)**
```bash
curl -H "Range: bytes=0-1048575" \
     https://mock-backend-poh8.onrender.com/video \
     -o chunk.mp4
```

**Use in a browser `<video>` tag**
```html
<video controls src="https://mock-backend-poh8.onrender.com/video"></video>
```

**Error responses**
- `404` — video file not found on the server
- `416` — requested byte range is out of bounds

---

### `GET /annotations`

Returns the full raw annotation JSON exactly as stored on the server. This is the same data the WebSocket stream uses internally — useful for inspecting the complete dataset upfront, building a scrubber, or pre-loading state.

**Request**
```
GET https://mock-backend-poh8.onrender.com/annotations
```

**Response** `200 OK` — `Content-Type: application/json`

The response follows the Google Video Intelligence API `AnnotateVideoResponse` shape:

```json
{
  "annotation_results": [
    {
      "segment_label_annotations": [ ... ],
      "shot_label_annotations": [ ... ],
      "shot_annotations": [ ... ],
      "object_tracking_annotations": [ ... ],
      "face_detection_annotations": [ ... ],
      "text_annotations": [ ... ],
      "speech_transcriptions": [ ... ]
    }
  ]
}
```

**Try it (curl)**
```bash
curl https://mock-backend-poh8.onrender.com/annotations | jq .
```

**Error responses**
- `500` — annotations file not found or unreadable on the server

---

## WebSocket Stream

### `ws://` vs `wss://`

Because the server is hosted on Render (HTTPS), use **`wss://`** (TLS WebSocket):

```
wss://mock-backend-poh8.onrender.com/ws/stream
```

### How it works

On connection, the server:

1. Reads `annotations.json` and flattens every annotation segment across all types into a single array.
2. Sorts all segments by their `start_time_offset` (ascending).
3. Schedules a `setTimeout` for each segment, firing at exactly `timestampMs` milliseconds after connection — mirroring real-time video playback from `t=0`.
4. Sends each annotation as a JSON message when its timer fires.
5. Sends a final `{ "type": "end" }` message 100 ms after the last annotation.

> **Important:** the stream clock starts the moment you open the WebSocket connection. To stay in sync with the video, open the WebSocket and start the video at the same time.

---

### Message Schema

Every message sent over the WebSocket is a JSON object.

#### Annotation message

```json
{
  "type": "annotation",
  "annotationType": "<string>",
  "timestampMs": 1234,
  "data": { ... }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"annotation"` | Identifies this as an annotation event |
| `annotationType` | string | One of the types listed below |
| `timestampMs` | number | Milliseconds from video start when this annotation begins |
| `data` | object | The raw annotation object (type-specific shape) |

#### End-of-stream message

```json
{ "type": "end" }
```

Sent after all annotation messages have been dispatched.

#### Error message

```json
{ "type": "error", "message": "Failed to parse annotations" }
```

Sent if the server fails to load or parse the annotations file.

---

### Annotation Types

| `annotationType` | Source field in annotations JSON | What it represents |
|------------------|-----------------------------------|--------------------|
| `segment_label` | `segment_label_annotations` | Labels for a continuous video segment (e.g. "outdoor", "sports") |
| `shot_label` | `shot_label_annotations` | Labels scoped to a detected shot/scene cut |
| `shot` | `shot_annotations` | A detected scene/shot boundary |
| `object_tracking` | `object_tracking_annotations` | A tracked object across frames (bounding boxes over time) |
| `face_detection` | `face_detection_annotations` | A detected face track |
| `text` | `text_annotations` | On-screen text detected via OCR |
| `speech` | `speech_transcriptions` | A speech transcription segment (timed to the first word) |

---

### Connecting — Quick Examples

**Browser (JavaScript)**
```javascript
const ws = new WebSocket('wss://mock-backend-poh8.onrender.com/ws/stream');

ws.onopen = () => {
  console.log('Connected — start your video now');
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  if (msg.type === 'end') {
    console.log('Stream complete');
    ws.close();
    return;
  }

  if (msg.type === 'annotation') {
    console.log(`[${msg.timestampMs}ms] ${msg.annotationType}`, msg.data);
  }

  if (msg.type === 'error') {
    console.error('Server error:', msg.message);
  }
};

ws.onerror = (err) => console.error('WebSocket error:', err);
ws.onclose = () => console.log('Connection closed');
```

**wscat (terminal)**
```bash
# install once
npm install -g wscat

# connect
wscat -c wss://mock-backend-poh8.onrender.com/ws/stream
```

**websocat (terminal)**
```bash
websocat wss://mock-backend-poh8.onrender.com/ws/stream
```

---

## Syncing Video + WebSocket

The intended usage pattern is to open the WebSocket and play the video simultaneously, so annotation events arrive at the correct visual moment:

```javascript
const video = document.querySelector('video');
const ws = new WebSocket('wss://mock-backend-poh8.onrender.com/ws/stream');

ws.onopen = () => {
  video.src = 'https://mock-backend-poh8.onrender.com/video';
  video.play();
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'annotation') {
    // render overlay, update UI, etc.
    renderAnnotation(msg);
  }
};
```

> Note: The server does not respond to seek/pause events. The stream is fire-and-forget from `t=0`. If the video is paused or seeked, the annotation stream stays on its original clock — there is no resync mechanism in this mock. Reconnect to restart from the beginning.

---

## Notes

- **Cold starts:** Render free-tier services spin down after inactivity. The first request after a cold start may take 30–60 seconds. Subsequent requests are fast.
- **No authentication:** All endpoints are open, no API keys required.
- **Read-only:** No write endpoints exist. The server serves static files only.
- **Reconnecting:** Closing and reopening the WebSocket restarts the annotation stream from `t=0`.