use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Dxgi::{
    IDXGIOutputDuplication, DXGI_OUTDUPL_FRAME_INFO, DXGI_OUTDUPL_POINTER_SHAPE_INFO,
    DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR, DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR,
    DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME,
};
use windows::Win32::Graphics::Gdi::{DeleteObject, HDC, HGDIOBJ};
use windows::Win32::UI::WindowsAndMessaging::{
    DrawIconEx, GetCursorInfo, GetIconInfo, CURSORINFO, CURSOR_SHOWING, CURSOR_SUPPRESSED,
    DI_NORMAL, HICON, ICONINFO,
};

const MAX_SHAPE_BYTES: u32 = 4 * 1024 * 1024;

#[derive(Default)]
pub struct DesktopPointer {
    shape: Vec<u8>,
    info: DXGI_OUTDUPL_POINTER_SHAPE_INFO,
    position: POINT,
    visible: bool,
    initialized: bool,
}

impl DesktopPointer {
    fn observe_position(&mut self, frame: &DXGI_OUTDUPL_FRAME_INFO) {
        if !self.initialized || frame.LastMouseUpdateTime != 0 {
            self.position = frame.PointerPosition.Position;
            self.visible = frame.PointerPosition.Visible.as_bool();
            self.initialized = true;
        }
    }

    pub unsafe fn update(
        &mut self,
        duplication: &IDXGIOutputDuplication,
        frame: &DXGI_OUTDUPL_FRAME_INFO,
    ) {
        self.observe_position(frame);
        let mut size = frame.PointerShapeBufferSize;
        if size == 0 && (!self.visible || !self.shape.is_empty()) {
            return;
        }
        if size == 0 {
            let _ = duplication.GetFramePointerShape(
                0,
                std::ptr::null_mut(),
                &mut size,
                &mut self.info,
            );
        }
        if size == 0 || size > MAX_SHAPE_BYTES {
            self.shape.clear();
            return;
        }
        self.shape.resize(size as usize, 0);
        let mut required = 0;
        if duplication
            .GetFramePointerShape(
                size,
                self.shape.as_mut_ptr().cast(),
                &mut required,
                &mut self.info,
            )
            .is_err()
            || required > size
        {
            self.shape.clear();
        }
    }

    pub fn composite(&self, image: &mut [u8], width: usize, height: usize) -> bool {
        // DXGI may already contain a software cursor; never draw it twice.
        !self.visible
            || composite_pointer(image, width, height, self.position, &self.info, &self.shape)
    }
}

fn composite_pointer(
    image: &mut [u8],
    width: usize,
    height: usize,
    position: POINT,
    info: &DXGI_OUTDUPL_POINTER_SHAPE_INFO,
    shape: &[u8],
) -> bool {
    let mono = info.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME.0 as u32;
    let masked = info.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR.0 as u32;
    let color = info.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR.0 as u32;
    let sw = info.Width as usize;
    let sh = info.Height as usize;
    let pitch = info.Pitch as usize;
    let rows = if mono { sh / 2 } else { sh };
    let required_pitch = if mono {
        sw.div_ceil(8)
    } else {
        sw.saturating_mul(4)
    };
    if (!mono && !masked && !color)
        || width == 0
        || height == 0
        || sw == 0
        || rows == 0
        || (mono && sh % 2 != 0)
        || pitch < required_pitch
        || pitch.checked_mul(sh).is_none_or(|n| n > shape.len())
        || width.checked_mul(height).and_then(|n| n.checked_mul(4)) != Some(image.len())
    {
        return false;
    }
    if masked
        && (0..rows).any(|y| (0..sw).any(|x| !matches!(shape[y * pitch + x * 4 + 3], 0 | 255)))
    {
        return false;
    }
    let left = i64::from(position.x).max(0);
    let top = i64::from(position.y).max(0);
    let right = (i64::from(position.x) + sw as i64).min(width as i64);
    let bottom = (i64::from(position.y) + rows as i64).min(height as i64);
    for y in top..bottom {
        for x in left..right {
            let sx = (x - i64::from(position.x)) as usize;
            let sy = (y - i64::from(position.y)) as usize;
            let target = (y as usize * width + x as usize) * 4;
            if mono {
                let bit = 0x80 >> (sx % 8);
                let and = if shape[sy * pitch + sx / 8] & bit != 0 {
                    255
                } else {
                    0
                };
                let xor = if shape[(sy + rows) * pitch + sx / 8] & bit != 0 {
                    255
                } else {
                    0
                };
                for c in 0..3 {
                    image[target + c] = (image[target + c] & and) ^ xor;
                }
            } else {
                let source = sy * pitch + sx * 4;
                let alpha = u32::from(shape[source + 3]);
                for c in 0..3 {
                    image[target + c] = if masked {
                        if alpha == 255 {
                            image[target + c] ^ shape[source + c]
                        } else {
                            shape[source + c]
                        }
                    } else {
                        ((u32::from(shape[source + c]) * alpha
                            + u32::from(image[target + c]) * (255 - alpha)
                            + 127)
                            / 255) as u8
                    };
                }
            }
        }
    }
    true
}

pub unsafe fn draw_gdi_cursor(dc: HDC, origin: POINT) -> bool {
    let mut cursor = CURSORINFO {
        cbSize: std::mem::size_of::<CURSORINFO>() as u32,
        ..Default::default()
    };
    if GetCursorInfo(&mut cursor).is_err() {
        return false;
    }
    draw_gdi_shape(dc, origin, &cursor)
}

unsafe fn draw_gdi_shape(dc: HDC, origin: POINT, cursor: &CURSORINFO) -> bool {
    if cursor.flags.0 & CURSOR_SHOWING.0 == 0 || cursor.flags.0 & CURSOR_SUPPRESSED.0 != 0 {
        return true;
    }
    let icon = HICON(cursor.hCursor.0);
    let mut info = ICONINFO::default();
    if GetIconInfo(icon, &mut info).is_err() {
        return false;
    }
    let x = i64::from(cursor.ptScreenPos.x) - i64::from(origin.x) - i64::from(info.xHotspot);
    let y = i64::from(cursor.ptScreenPos.y) - i64::from(origin.y) - i64::from(info.yHotspot);
    let drawn = match (i32::try_from(x), i32::try_from(y)) {
        // shortcut: GDI uses animation frame zero; extend only if fallback animation phase is required.
        (Ok(x), Ok(y)) => DrawIconEx(dc, x, y, icon, 0, 0, 0, None, DI_NORMAL).is_ok(),
        _ => false,
    };
    // GetIconInfo allocates both bitmaps; the shared OS cursor itself is not ours.
    for bitmap in [info.hbmMask, info.hbmColor] {
        if bitmap.0 != 0 {
            let _ = DeleteObject(HGDIOBJ(bitmap.0));
        }
    }
    drawn
}

#[cfg(test)]
#[path = "remote_cursor_test.rs"]
mod tests;
