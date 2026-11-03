use super::*;

fn info(kind: u32, width: u32, height: u32, pitch: u32) -> DXGI_OUTDUPL_POINTER_SHAPE_INFO {
    DXGI_OUTDUPL_POINTER_SHAPE_INFO {
        Type: kind,
        Width: width,
        Height: height,
        Pitch: pitch,
        HotSpot: POINT { x: 99, y: 99 },
    }
}
fn background(pixels: usize) -> Vec<u8> {
    [18, 52, 86, 255].repeat(pixels)
}

#[test]
fn remote_cursor_preserves_all_monochrome_and_xor_operations() {
    let mut image = background(4);
    assert!(composite_pointer(
        &mut image,
        4,
        1,
        POINT { x: 0, y: 0 },
        &info(1, 4, 2, 1),
        &[0x50, 0x30]
    ));
    assert_eq!(
        image,
        [0, 0, 0, 255, 18, 52, 86, 255, 255, 255, 255, 255, 237, 203, 169, 255]
    );
    let mut padded = background(9);
    assert!(composite_pointer(
        &mut padded,
        9,
        1,
        POINT::default(),
        &info(1, 9, 2, 2),
        &[255, 128, 0, 128]
    ));
    assert_eq!(&padded[0..32], &background(8));
    assert_eq!(&padded[32..], &[237, 203, 169, 255]);
}

#[test]
fn remote_cursor_blends_color_and_handles_masked_color() {
    let mut image = background(3);
    let shape = [
        100, 120, 140, 0, 100, 120, 140, 255, 100, 120, 140, 128, 0, 0, 0, 0,
    ];
    assert!(composite_pointer(
        &mut image,
        3,
        1,
        POINT::default(),
        &info(2, 3, 1, 16),
        &shape
    ));
    assert_eq!(&image[0..4], &[18, 52, 86, 255]);
    assert_eq!(&image[4..8], &[100, 120, 140, 255]);
    assert_eq!(&image[8..12], &[59, 86, 113, 255]);
    let mut masked = background(2);
    assert!(composite_pointer(
        &mut masked,
        2,
        1,
        POINT::default(),
        &info(4, 2, 1, 8),
        &[1, 2, 3, 0, 255, 0, 255, 255]
    ));
    assert_eq!(masked, [1, 2, 3, 255, 237, 52, 169, 255]);
}

#[test]
fn remote_cursor_clips_negative_and_outside_positions_without_hotspot_offset() {
    let shape = [1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255];
    let mut image = background(4);
    assert!(composite_pointer(
        &mut image,
        2,
        2,
        POINT { x: -1, y: -1 },
        &info(2, 2, 2, 8),
        &shape
    ));
    assert_eq!(&image[0..4], &[10, 11, 12, 255]);
    assert_eq!(&image[4..], &background(3));
    let original = image.clone();
    assert!(composite_pointer(
        &mut image,
        2,
        2,
        POINT { x: i32::MAX, y: 0 },
        &info(2, 2, 2, 8),
        &shape
    ));
    assert_eq!(image, original);
}

#[test]
fn remote_cursor_rejects_invalid_shapes_without_changing_picture() {
    let original = background(2);
    for (metadata, data) in [
        (info(1, 2, 3, 1), vec![255; 3]),
        (info(2, 2, 1, 7), vec![255; 8]),
        (info(2, 2, 1, 8), vec![255; 7]),
        (info(8, 2, 1, 8), vec![255; 8]),
        (info(4, 2, 1, 8), vec![1, 2, 3, 0, 4, 5, 6, 128]),
    ] {
        let mut image = original.clone();
        assert!(!composite_pointer(
            &mut image,
            2,
            1,
            POINT::default(),
            &metadata,
            &data
        ));
        assert_eq!(image, original);
    }
}

#[test]
fn remote_cursor_stationary_frames_are_identical_and_new_frames_leave_no_trail() {
    let base = background(16);
    let shape = [255, 255, 255, 255];
    let metadata = info(2, 1, 1, 4);
    let mut first = base.clone();
    let mut repeated = base.clone();
    let mut moved = base.clone();
    assert!(composite_pointer(
        &mut first,
        4,
        4,
        POINT { x: 0, y: 0 },
        &metadata,
        &shape
    ));
    assert!(composite_pointer(
        &mut repeated,
        4,
        4,
        POINT { x: 0, y: 0 },
        &metadata,
        &shape
    ));
    assert!(composite_pointer(
        &mut moved,
        4,
        4,
        POINT { x: 3, y: 3 },
        &metadata,
        &shape
    ));
    assert_eq!(first, repeated);
    assert_eq!(&moved[0..4], &base[0..4]);
    assert_eq!(&moved[60..64], &[255, 255, 255, 255]);
}

#[test]
fn remote_cursor_keeps_position_without_mouse_update_and_never_doubles_embedded_cursor() {
    let mut pointer = DesktopPointer::default();
    let mut frame = DXGI_OUTDUPL_FRAME_INFO::default();
    frame.PointerPosition.Position = POINT { x: 12, y: 8 };
    frame.PointerPosition.Visible = true.into();
    pointer.observe_position(&frame);
    pointer.observe_position(&DXGI_OUTDUPL_FRAME_INFO::default());
    assert!(pointer.visible);
    assert_eq!(pointer.position.x, 12);
    frame.LastMouseUpdateTime = 1;
    frame.PointerPosition.Visible = false.into();
    pointer.observe_position(&frame);
    let mut image = background(1);
    assert!(pointer.composite(&mut image, 1, 1));
    assert_eq!(image, background(1));
}

#[test]
fn remote_cursor_gdi_draws_real_stock_shapes_with_negative_monitor_origin() {
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, GdiFlush, SelectObject, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        LoadCursorW, IDC_ARROW, IDC_HAND, IDC_IBEAM,
    };
    unsafe {
        assert!(draw_gdi_shape(
            HDC::default(),
            POINT::default(),
            &CURSORINFO::default()
        ));
        let mut suppressed = CURSORINFO {
            flags: CURSOR_SHOWING,
            ..Default::default()
        };
        suppressed.flags.0 |= CURSOR_SUPPRESSED.0;
        assert!(draw_gdi_shape(
            HDC::default(),
            POINT::default(),
            &suppressed
        ));
        let dc = CreateCompatibleDC(None);
        let mut bits = std::ptr::null_mut();
        let header = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: 96,
                biHeight: -96,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let bitmap = CreateDIBSection(dc, &header, DIB_RGB_COLORS, &mut bits, None, 0).unwrap();
        let old = SelectObject(dc, HGDIOBJ(bitmap.0));
        let image = std::slice::from_raw_parts_mut(bits.cast::<u8>(), 96 * 96 * 4);
        let original = background(96 * 96);
        let mut pictures = Vec::new();
        for name in [IDC_ARROW, IDC_IBEAM, IDC_HAND] {
            image.copy_from_slice(&original);
            let cursor = CURSORINFO {
                cbSize: std::mem::size_of::<CURSORINFO>() as u32,
                flags: CURSOR_SHOWING,
                hCursor: LoadCursorW(None, name).unwrap(),
                ptScreenPos: POINT {
                    x: -1920 + 48,
                    y: 48,
                },
            };
            assert!(draw_gdi_shape(dc, POINT { x: -1920, y: 0 }, &cursor));
            let _ = GdiFlush();
            pictures.push(image.to_vec());
        }
        let _ = SelectObject(dc, old);
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = DeleteDC(dc);
        assert!(pictures.iter().all(|p| p != &original));
        assert_ne!(pictures[0], pictures[1]);
        assert_ne!(pictures[1], pictures[2]);
    }
}
