// Package embed provides the OpenAI embeddings client and the background
// worker that vectorizes new messages.
package embed

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const (
	Model      = "text-embedding-3-small"
	Dimensions = 1536
	// the model's context is 8191 tokens; cap input defensively by bytes
	maxInputBytes = 20000
)

type OpenAIEmbedder struct {
	apiKey string
	client *http.Client
	url    string
}

func NewOpenAI(apiKey string) *OpenAIEmbedder {
	return &OpenAIEmbedder{
		apiKey: apiKey,
		client: &http.Client{Timeout: 30 * time.Second},
		url:    "https://api.openai.com/v1/embeddings",
	}
}

type embedRequest struct {
	Model string   `json:"model"`
	Input []string `json:"input"`
}

type embedResponse struct {
	Data []struct {
		Index     int       `json:"index"`
		Embedding []float32 `json:"embedding"`
	} `json:"data"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

func (e *OpenAIEmbedder) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	input := make([]string, len(texts))
	for i, t := range texts {
		if len(t) > maxInputBytes {
			t = t[:maxInputBytes]
		}
		if t == "" {
			t = " " // the API rejects empty strings
		}
		input[i] = t
	}

	body, err := json.Marshal(embedRequest{Model: Model, Input: input})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, e.url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+e.apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := e.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 100*1024*1024))
	if err != nil {
		return nil, err
	}
	var parsed embedResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("embeddings API returned status %d", resp.StatusCode)
	}
	if resp.StatusCode != http.StatusOK {
		msg := "unknown error"
		if parsed.Error != nil {
			msg = parsed.Error.Message
		}
		return nil, fmt.Errorf("embeddings API status %d: %s", resp.StatusCode, msg)
	}
	if len(parsed.Data) != len(texts) {
		return nil, fmt.Errorf("embeddings API returned %d vectors for %d inputs", len(parsed.Data), len(texts))
	}

	out := make([][]float32, len(texts))
	for _, d := range parsed.Data {
		if d.Index < 0 || d.Index >= len(out) {
			return nil, fmt.Errorf("embeddings API returned bad index %d", d.Index)
		}
		out[d.Index] = d.Embedding
	}
	return out, nil
}
