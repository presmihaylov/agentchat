package imgvariant

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"testing"
)

func square(t *testing.T, n int, enc func(*bytes.Buffer, image.Image)) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, n, n))
	for y := 0; y < n; y++ {
		for x := 0; x < n; x++ {
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), 128, 255})
		}
	}
	var buf bytes.Buffer
	enc(&buf, img)
	return buf.Bytes()
}

func dims(t *testing.T, data []byte) (int, int, string) {
	t.Helper()
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	return cfg.Width, cfg.Height, format
}

func TestMakeShrinksPNG(t *testing.T) {
	src := square(t, 1254, func(b *bytes.Buffer, i image.Image) { _ = png.Encode(b, i) })
	v, err := Make(src, "image/png")
	if err != nil {
		t.Fatal(err)
	}
	if w, h, f := dims(t, v.Small); w != 128 || h != 128 || f != "png" {
		t.Fatalf("small: %dx%d %s", w, h, f)
	}
	if w, h, f := dims(t, v.Large); w != 512 || h != 512 || f != "png" {
		t.Fatalf("large: %dx%d %s", w, h, f)
	}
	if v.ContentType != "image/png" || len(v.Small) >= len(src)/10 || len(v.Large) >= len(src) {
		t.Fatalf("sizes: src %d small %d large %d %s", len(src), len(v.Small), len(v.Large), v.ContentType)
	}
}

func TestMakeKeepsJPEGAndAspect(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 1000, 500))
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, nil)
	v, err := Make(buf.Bytes(), "image/jpeg")
	if err != nil {
		t.Fatal(err)
	}
	if w, h, f := dims(t, v.Small); w != 128 || h != 64 || f != "jpeg" || v.ContentType != "image/jpeg" {
		t.Fatalf("small: %dx%d %s %s", w, h, f, v.ContentType)
	}
}

func TestMakeNeverUpscales(t *testing.T) {
	src := square(t, 64, func(b *bytes.Buffer, i image.Image) { _ = png.Encode(b, i) })
	v, err := Make(src, "image/png")
	if err != nil {
		t.Fatal(err)
	}
	if w, _, _ := dims(t, v.Small); w != 64 {
		t.Fatalf("small upscaled to %d", w)
	}
	if w, _, _ := dims(t, v.Large); w != 64 {
		t.Fatalf("large upscaled to %d", w)
	}
}

func TestMakeRejectsNonImages(t *testing.T) {
	for _, in := range [][]byte{[]byte("nope"), {}, []byte("<svg xmlns='http://www.w3.org/2000/svg'/>")} {
		if _, err := Make(in, "image/png"); !errors.Is(err, ErrUnsupported) {
			t.Fatalf("%q: %v", in, err)
		}
	}
}
