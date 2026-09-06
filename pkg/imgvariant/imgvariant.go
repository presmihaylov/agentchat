// Package imgvariant makes the small copies of an uploaded image that the UI
// draws in place of the original: avatars and logos render at 20 to 96px, so
// serving a multi-megabyte upload for them is the whole cost of a page load.
package imgvariant

import (
	"bytes"
	"errors"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"strings"

	"golang.org/x/image/draw"
	"golang.org/x/image/webp"
)

const (
	Small = 128
	Large = 512
	// a decode bomb guard: 8000x8000 RGBA is 256MB
	maxPixels = 5000 * 5000 // a 5MB png at this size decodes to ~100MB rgba; any real avatar fits
)

var ErrUnsupported = errors.New("image format not supported")

type Variants struct {
	Small, Large []byte
	ContentType  string
}

// Make decodes data (png, jpeg, gif, webp) and returns it fitted inside the
// Small and Large boxes. Aspect ratio is kept, nothing is upscaled: a 64px
// source yields 64px variants. JPEG sources stay JPEG, anything else becomes
// PNG so transparency survives.
func Make(data []byte, contentType string) (Variants, error) {
	src, err := decode(data, contentType)
	if err != nil {
		return Variants{}, err
	}
	asJPEG := strings.HasPrefix(strings.ToLower(contentType), "image/jpeg")
	v := Variants{ContentType: "image/png"}
	if asJPEG {
		v.ContentType = "image/jpeg"
	}
	if v.Small, err = encode(fit(src, Small), asJPEG); err != nil {
		return Variants{}, err
	}
	if v.Large, err = encode(fit(src, Large), asJPEG); err != nil {
		return Variants{}, err
	}
	return v, nil
}

func decode(data []byte, contentType string) (image.Image, error) {
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		// stdlib registers png/jpeg/gif; webp is only reachable by hand
		if strings.HasPrefix(strings.ToLower(contentType), "image/webp") {
			img, werr := webp.Decode(bytes.NewReader(data))
			if werr != nil {
				return nil, ErrUnsupported
			}
			return guard(img)
		}
		return nil, ErrUnsupported
	}
	if cfg.Width*cfg.Height > maxPixels {
		return nil, ErrUnsupported
	}
	var img image.Image
	switch format {
	case "gif":
		img, err = gif.Decode(bytes.NewReader(data)) // first frame
	default:
		img, _, err = image.Decode(bytes.NewReader(data))
	}
	if err != nil {
		return nil, ErrUnsupported
	}
	return guard(img)
}

func guard(img image.Image) (image.Image, error) {
	b := img.Bounds()
	if b.Dx()*b.Dy() > maxPixels {
		return nil, ErrUnsupported
	}
	return img, nil
}

// fit scales img so its longer side is at most box px.
func fit(img image.Image, box int) image.Image {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= box && h <= box {
		return img
	}
	if w >= h {
		h = max(1, h*box/w)
		w = box
	}
	if h > w {
		w = max(1, w*box/h)
		h = box
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.CatmullRom.Scale(dst, dst.Bounds(), img, b, draw.Over, nil)
	return dst
}

func encode(img image.Image, asJPEG bool) ([]byte, error) {
	var buf bytes.Buffer
	if asJPEG {
		err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 85})
		return buf.Bytes(), err
	}
	enc := png.Encoder{CompressionLevel: png.BestCompression}
	err := enc.Encode(&buf, img)
	return buf.Bytes(), err
}
