import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());

// Paths
const VIDEO_PATH = path.join(__dirname, '../video.mp4');
const ANNOTATIONS_PATH = path.join(__dirname, '../annotations.json');

// HTTP Routes
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/annotations', (req, res) => {
  try {
    const data = fs.readFileSync(ANNOTATIONS_PATH, 'utf-8');
    // Using res.type('json') to ensure it is sent as application/json
    res.type('json').send(data);
  } catch (error) {
    res.status(500).json({ error: 'Annotations not found' });
  }
});

app.get('/video', (req, res) => {
  try {
    const stat = fs.statSync(VIDEO_PATH);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (start >= fileSize) {
        res.status(416).send('Requested range not satisfiable\n' + start + ' >= ' + fileSize);
        return;
      }

      const chunksize = (end - start) + 1;
      const file = fs.createReadStream(VIDEO_PATH, { start, end });
      const head = {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/mp4',
      };

      res.writeHead(206, head);
      file.pipe(res);
    } else {
      const head = {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
      };
      res.writeHead(200, head);
      fs.createReadStream(VIDEO_PATH).pipe(res);
    }
  } catch (err) {
    res.status(404).send('Video file not found');
  }
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/stream' });

wss.on('connection', (ws) => {
  let pendingTimeouts = [];

  try {
    const annotationsRaw = fs.readFileSync(ANNOTATIONS_PATH, 'utf-8');
    const annotationsData = JSON.parse(annotationsRaw);

    // 1. & 2. Flatten ALL annotation segments across all types into one array
    const allSegments = [];

    function processResult(result) {
      const processStandard = (annotations, typeName) => {
        if (!annotations) return;
        annotations.forEach(item => {
          if (item.segments) {
            item.segments.forEach(segInfo => {
              if (segInfo.segment && segInfo.segment.start_time_offset) {
                const s = segInfo.segment.start_time_offset.seconds || 0;
                const n = segInfo.segment.start_time_offset.nanos || 0;
                const timestampMs = (s * 1000) + (n / 1000000);
                allSegments.push({ timestampMs, type: typeName, data: item });
              }
            });
          }
        });
      };

      processStandard(result.segment_label_annotations, 'segment_label');
      processStandard(result.shot_label_annotations, 'shot_label');

      if (result.shot_annotations) {
        result.shot_annotations.forEach(shot => {
          if (shot.start_time_offset) {
            const s = shot.start_time_offset.seconds || 0;
            const n = shot.start_time_offset.nanos || 0;
            const timestampMs = (s * 1000) + (n / 1000000);
            allSegments.push({ timestampMs, type: 'shot', data: shot });
          }
        });
      }

      if (result.object_tracking_annotations) {
        result.object_tracking_annotations.forEach(obj => {
          if (obj.segment && obj.segment.start_time_offset) {
            const s = obj.segment.start_time_offset.seconds || 0;
            const n = obj.segment.start_time_offset.nanos || 0;
            const timestampMs = (s * 1000) + (n / 1000000);
            allSegments.push({ timestampMs, type: 'object_tracking', data: obj });
          }
        });
      }

      if (result.face_detection_annotations) {
        result.face_detection_annotations.forEach(face => {
          if (face.tracks) {
            face.tracks.forEach(track => {
              if (track.segment && track.segment.start_time_offset) {
                const s = track.segment.start_time_offset.seconds || 0;
                const n = track.segment.start_time_offset.nanos || 0;
                const timestampMs = (s * 1000) + (n / 1000000);
                allSegments.push({ timestampMs, type: 'face_detection', data: face });
              }
            });
          }
        });
      }

      if (result.text_annotations) {
        result.text_annotations.forEach(text => {
          if (text.segments) {
            text.segments.forEach(seg => {
              if (seg.segment && seg.segment.start_time_offset) {
                const s = seg.segment.start_time_offset.seconds || 0;
                const n = seg.segment.start_time_offset.nanos || 0;
                const timestampMs = (s * 1000) + (n / 1000000);
                allSegments.push({ timestampMs, type: 'text', data: text });
              }
            });
          }
        });
      }

      if (result.speech_transcriptions) {
        result.speech_transcriptions.forEach(speech => {
          if (speech.alternatives && speech.alternatives.length > 0) {
            const alt = speech.alternatives[0];
            if (alt.words && alt.words.length > 0) {
              const firstWord = alt.words[0];
              if (firstWord.start_time) {
                const s = firstWord.start_time.seconds || 0;
                const n = firstWord.start_time.nanos || 0;
                const timestampMs = (s * 1000) + (n / 1000000);
                allSegments.push({ timestampMs, type: 'speech', data: speech });
              }
            }
          }
        });
      }
    }

    if (annotationsData.annotation_results) {
      annotationsData.annotation_results.forEach(processResult);
    }

    // 3. Sort by timestampMs ascending
    allSegments.sort((a, b) => a.timestampMs - b.timestampMs);

    // 4. & 5. Walk the array, for each item schedule a setTimeout
    allSegments.forEach(item => {
      const timeoutId = setTimeout(() => {
        if (ws.readyState === ws.OPEN) {
          const payload = {
            type: "annotation",
            annotationType: item.type,
            timestampMs: item.timestampMs,
            data: item.data
          };
          ws.send(JSON.stringify(payload));
        }
      }, item.timestampMs);
      pendingTimeouts.push(timeoutId);
    });

    // 6. After the last one, send { type: "end" }
    if (allSegments.length > 0) {
      const maxTimestamp = allSegments[allSegments.length - 1].timestampMs;
      const endTimeoutId = setTimeout(() => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "end" }));
        }
      }, maxTimestamp + 100);
      pendingTimeouts.push(endTimeoutId);
    } else {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "end" }));
      }
    }

  } catch (error) {
    console.error('WebSocket error:', error);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "error", message: "Failed to parse annotations" }));
    }
  }

  // 7. On ws close, clear all pending timeouts
  ws.on('close', () => {
    pendingTimeouts.forEach(id => clearTimeout(id));
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Mock server running on port ${PORT}`);
  console.log(`- Health: http://localhost:${PORT}/health`);
  console.log(`- Annotations: http://localhost:${PORT}/annotations`);
  console.log(`- Video: http://localhost:${PORT}/video`);
  console.log(`- WebSocket stream: ws://localhost:${PORT}/ws/stream`);
});
