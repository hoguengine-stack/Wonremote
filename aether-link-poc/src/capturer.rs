use windows::core::{ComInterface, Error, Result, HSTRING};
use windows::Win32::Foundation::{BOOL, E_INVALIDARG, LPARAM, RECT};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_1};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_CPU_ACCESS_READ,
    D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter1, IDXGIFactory1, IDXGIOutput1, IDXGIOutputDuplication,
    DXGI_ADAPTER_DESC1, DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO,
    DXGI_OUTPUT_DESC,
};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject,
    EnumDisplayMonitors, GetDC, GetDIBits, GetMonitorInfoW, ReleaseDC, SelectObject, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HDC, HGDIOBJ, HMONITOR, MONITORINFO, MONITORINFOEXW,
    SRCCOPY,
};

pub struct DesktopCapturer {
    backend: CaptureBackend,
}

enum CaptureBackend {
    Dxgi(DxgiCapturer),
    Gdi(GdiCapturer),
}

impl DesktopCapturer {
    pub fn new_stream(output_index: u32) -> Result<Self> {
        if should_force_gdi_capture_backend() {
            eprintln!("Using GDI BitBlt capture because WONREMOTE_CAPTURE_BACKEND=gdi.");
            return Ok(Self {
                backend: CaptureBackend::Gdi(GdiCapturer::new(output_index)?),
            });
        }

        match DxgiCapturer::new(output_index) {
            Ok(capturer) => Ok(Self {
                backend: CaptureBackend::Dxgi(capturer),
            }),
            Err(dxgi_error) => {
                eprintln!(
                    "DXGI capture init failed: {:?}. Falling back to GDI BitBlt capture.",
                    dxgi_error
                );
                Ok(Self {
                    backend: CaptureBackend::Gdi(GdiCapturer::new(output_index)?),
                })
            }
        }
    }

    pub fn capture_frame(&mut self, timeout_ms: u32) -> Result<CaptureFrameStatus> {
        match &mut self.backend {
            CaptureBackend::Dxgi(capturer) => capturer.capture_frame(timeout_ms),
            CaptureBackend::Gdi(capturer) => capturer.capture_frame(),
        }
    }

    pub fn get_dimensions(&self) -> (u32, u32) {
        match &self.backend {
            CaptureBackend::Dxgi(capturer) => capturer.get_dimensions(),
            CaptureBackend::Gdi(capturer) => capturer.get_dimensions(),
        }
    }

    pub fn get_selection_names(&self) -> (String, String) {
        match &self.backend {
            CaptureBackend::Dxgi(capturer) => capturer.get_selection_names(),
            CaptureBackend::Gdi(capturer) => capturer.get_selection_names(),
        }
    }

    pub fn recommended_min_loop_sleep_ms(&self) -> u64 {
        match &self.backend {
            CaptureBackend::Dxgi(_) => 0,
            CaptureBackend::Gdi(_) => 125,
        }
    }
}

fn should_force_gdi_capture_backend() -> bool {
    std::env::var("WONREMOTE_CAPTURE_BACKEND")
        .map(|value| value.eq_ignore_ascii_case("gdi"))
        .unwrap_or(false)
}

pub enum CaptureFrameStatus {
    Frame {
        bgra: Vec<u8>,
        rgb565: Vec<u8>,
        capture_time_us: u128,
        convert_time_us: u128,
    },
    Timeout,
    AccessLost,
}

pub struct DxgiCapturer {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    duplication: Option<IDXGIOutputDuplication>,
    staging_texture: Option<ID3D11Texture2D>,
    width: u32,
    height: u32,
    adapter_name: String,
    output_name: String,
    output_index: u32,
}

pub struct GdiCapturer {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    output_name: String,
}

fn select_gdi_output(output_index: u32) -> Result<(RECT, String)> {
    let mut outputs: Vec<(RECT, String)> = Vec::new();
    let success = unsafe {
        EnumDisplayMonitors(
            HDC(0),
            None,
            Some(enum_gdi_output),
            LPARAM((&mut outputs as *mut Vec<(RECT, String)>) as isize),
        )
    };
    if !success.as_bool() {
        return Err(Error::from_win32());
    }
    outputs.get(output_index as usize).cloned().ok_or_else(|| {
        Error::new(
            E_INVALIDARG,
            HSTRING::from(format!("GDI output index {output_index} is unavailable")),
        )
    })
}

unsafe extern "system" fn enum_gdi_output(
    monitor: HMONITOR,
    _monitor_dc: HDC,
    _monitor_rect: *mut RECT,
    context: LPARAM,
) -> BOOL {
    let outputs = &mut *(context.0 as *mut Vec<(RECT, String)>);
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    if GetMonitorInfoW(
        monitor,
        &mut info as *mut MONITORINFOEXW as *mut MONITORINFO,
    )
    .as_bool()
    {
        let name = utf16_to_string(&info.szDevice);
        outputs.push((info.monitorInfo.rcMonitor, name));
    }
    BOOL(1)
}

impl GdiCapturer {
    pub fn new(output_index: u32) -> Result<Self> {
        let (rect, output_name) = select_gdi_output(output_index)?;
        let (x, y, width, height) = gdi_capture_geometry(rect)
            .ok_or_else(|| Error::new(E_INVALIDARG, "GDI output has invalid dimensions".into()))?;
        Ok(Self {
            x,
            y,
            width,
            height,
            output_name,
        })
    }

    pub fn capture_frame(&mut self) -> Result<CaptureFrameStatus> {
        unsafe {
            let capture_start = std::time::Instant::now();
            let screen_dc = GetDC(None);
            if screen_dc.0 == 0 {
                return Err(Error::from_win32());
            }

            let memory_dc = CreateCompatibleDC(screen_dc);
            if memory_dc.0 == 0 {
                let _ = ReleaseDC(None, screen_dc);
                return Err(Error::from_win32());
            }

            let bitmap = CreateCompatibleBitmap(screen_dc, self.width as i32, self.height as i32);
            if bitmap.0 == 0 {
                let _ = DeleteDC(memory_dc);
                let _ = ReleaseDC(None, screen_dc);
                return Err(Error::from_win32());
            }

            let bitmap_object = HGDIOBJ(bitmap.0);
            let old_object = SelectObject(memory_dc, bitmap_object);
            let blit_result = BitBlt(
                memory_dc,
                0,
                0,
                self.width as i32,
                self.height as i32,
                screen_dc,
                self.x,
                self.y,
                SRCCOPY,
            );

            let blit_error = blit_result.err();
            let _ = SelectObject(memory_dc, old_object);

            let mut bgra_buffer = vec![0u8; (self.width * self.height * 4) as usize];
            let mut bitmap_info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: self.width as i32,
                    biHeight: -(self.height as i32),
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };

            let copied_rows = if blit_error.is_none() {
                GetDIBits(
                    memory_dc,
                    bitmap,
                    0,
                    self.height,
                    Some(bgra_buffer.as_mut_ptr() as *mut _),
                    &mut bitmap_info,
                    DIB_RGB_COLORS,
                )
            } else {
                0
            };
            let dibits_error = if blit_error.is_none() && copied_rows == 0 {
                Some(Error::from_win32())
            } else {
                None
            };

            let _ = DeleteObject(bitmap_object);
            let _ = DeleteDC(memory_dc);
            let _ = ReleaseDC(None, screen_dc);

            if let Some(error) = blit_error {
                return Err(error);
            }

            if let Some(error) = dibits_error {
                return Err(error);
            }

            let capture_time = capture_start.elapsed().as_micros();
            let convert_start = std::time::Instant::now();
            let rgb565_buffer =
                bgra_to_rgb565(&bgra_buffer, self.width as usize, self.height as usize);
            let convert_time = convert_start.elapsed().as_micros();

            Ok(CaptureFrameStatus::Frame {
                bgra: bgra_buffer,
                rgb565: rgb565_buffer,
                capture_time_us: capture_time,
                convert_time_us: convert_time,
            })
        }
    }

    pub fn get_dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    pub fn get_selection_names(&self) -> (String, String) {
        ("GDI".to_string(), self.output_name.clone())
    }
}

fn gdi_capture_geometry(rect: RECT) -> Option<(i32, i32, u32, u32)> {
    let width = rect.right.checked_sub(rect.left)?;
    let height = rect.bottom.checked_sub(rect.top)?;
    if width <= 0 || height <= 0 {
        return None;
    }
    Some((rect.left, rect.top, width as u32, height as u32))
}

impl DxgiCapturer {
    pub fn new(output_index: u32) -> Result<Self> {
        unsafe {
            let mut device: Option<ID3D11Device> = None;
            let mut context: Option<ID3D11DeviceContext> = None;
            let mut feature_level = D3D_FEATURE_LEVEL_11_1;

            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                None,
                Default::default(),
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                Some(&mut feature_level),
                Some(&mut context),
            )?;

            let device = device.unwrap();
            let context = context.unwrap();

            let mut capturer = Self {
                device,
                context,
                duplication: None,
                staging_texture: None,
                width: 0,
                height: 0,
                adapter_name: String::new(),
                output_name: String::new(),
                output_index,
            };

            capturer.init_duplication()?;
            Ok(capturer)
        }
    }

    pub fn init_duplication(&mut self) -> Result<()> {
        unsafe {
            let factory: IDXGIFactory1 = CreateDXGIFactory1()?;
            let adapter: IDXGIAdapter1 = factory.EnumAdapters1(0)?;
            let output = adapter.EnumOutputs(self.output_index)?;
            let output1: IDXGIOutput1 = output.cast()?;

            let mut adapter_desc = DXGI_ADAPTER_DESC1::default();
            adapter.GetDesc1(&mut adapter_desc)?;
            let mut output_desc = DXGI_OUTPUT_DESC::default();
            output.GetDesc(&mut output_desc)?;

            let duplication = output1.DuplicateOutput(&self.device)?;
            let mut desc = windows::Win32::Graphics::Dxgi::DXGI_OUTDUPL_DESC::default();
            duplication.GetDesc(&mut desc);

            self.width = desc.ModeDesc.Width;
            self.height = desc.ModeDesc.Height;
            self.adapter_name = utf16_to_string(&adapter_desc.Description);
            self.output_name = utf16_to_string(&output_desc.DeviceName);
            self.duplication = Some(duplication);
            self.staging_texture = None;

            Ok(())
        }
    }

    /// Captures a frame and preserves the reason when no frame is available.
    pub fn capture_frame(&mut self, timeout_ms: u32) -> Result<CaptureFrameStatus> {
        unsafe {
            if self.duplication.is_none() {
                self.init_duplication()?;
            }

            let duplication = self.duplication.as_ref().unwrap();
            let mut frame_info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut resource = None;

            let capture_start = std::time::Instant::now();
            match duplication.AcquireNextFrame(timeout_ms, &mut frame_info, &mut resource) {
                Ok(_) => {
                    let resource = resource.unwrap();
                    let texture: ID3D11Texture2D = resource.cast()?;

                    if self.staging_texture.is_none() {
                        let mut desc = D3D11_TEXTURE2D_DESC::default();
                        texture.GetDesc(&mut desc);

                        desc.Usage = D3D11_USAGE_STAGING;
                        desc.BindFlags = 0;
                        desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
                        desc.MiscFlags = 0;

                        let mut staging = None;
                        self.device
                            .CreateTexture2D(&desc, None, Some(&mut staging))?;
                        self.staging_texture = staging;
                    }

                    let staging_texture = self.staging_texture.as_ref().unwrap();
                    self.context.CopyResource(staging_texture, &texture);

                    let mut mapped_subresource = Default::default();
                    self.context.Map(
                        staging_texture,
                        0,
                        windows::Win32::Graphics::Direct3D11::D3D11_MAP_READ,
                        0,
                        Some(&mut mapped_subresource),
                    )?;

                    let mut desc = D3D11_TEXTURE2D_DESC::default();
                    staging_texture.GetDesc(&mut desc);

                    let row_pitch = mapped_subresource.RowPitch as usize;
                    let height = desc.Height as usize;
                    let width = desc.Width as usize;
                    let data_slice = std::slice::from_raw_parts(
                        mapped_subresource.pData as *const u8,
                        row_pitch * height,
                    );

                    // 1. Copy to a clean BGRA buffer (remove pitch padding)
                    let mut bgra_buffer = vec![0u8; width * height * 4];
                    for y in 0..height {
                        let src_start = y * row_pitch;
                        let dest_start = y * width * 4;
                        bgra_buffer[dest_start..dest_start + width * 4]
                            .copy_from_slice(&data_slice[src_start..src_start + width * 4]);
                    }

                    self.context.Unmap(staging_texture, 0);
                    let _ = duplication.ReleaseFrame();
                    let capture_time = capture_start.elapsed().as_micros();

                    let convert_start = std::time::Instant::now();
                    let rgb565_buffer = bgra_to_rgb565(&bgra_buffer, width, height);
                    let convert_time = convert_start.elapsed().as_micros();

                    Ok(CaptureFrameStatus::Frame {
                        bgra: bgra_buffer,
                        rgb565: rgb565_buffer,
                        capture_time_us: capture_time,
                        convert_time_us: convert_time,
                    })
                }
                Err(e) => {
                    if e.code() == DXGI_ERROR_WAIT_TIMEOUT {
                        Ok(CaptureFrameStatus::Timeout)
                    } else if e.code() == DXGI_ERROR_ACCESS_LOST {
                        self.duplication = None;
                        Ok(CaptureFrameStatus::AccessLost)
                    } else {
                        Err(e)
                    }
                }
            }
        }
    }

    pub fn get_dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    pub fn get_selection_names(&self) -> (String, String) {
        (self.adapter_name.clone(), self.output_name.clone())
    }
}

fn utf16_to_string(buffer: &[u16]) -> String {
    let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..len])
}

fn bgra_to_rgb565(bgra_buffer: &[u8], width: usize, height: usize) -> Vec<u8> {
    let mut rgb565_buffer = vec![0u8; width * height * 2];

    for i in 0..(width * height) {
        let bgra_idx = i * 4;
        let rgb565_idx = i * 2;

        let b = bgra_buffer[bgra_idx];
        let g = bgra_buffer[bgra_idx + 1];
        let r = bgra_buffer[bgra_idx + 2];

        let r5 = (r >> 3) as u16;
        let g6 = (g >> 2) as u16;
        let b5 = (b >> 3) as u16;

        let rgb565_val = (r5 << 11) | (g6 << 5) | b5;
        rgb565_buffer[rgb565_idx] = (rgb565_val & 0xFF) as u8;
        rgb565_buffer[rgb565_idx + 1] = ((rgb565_val >> 8) & 0xFF) as u8;
    }

    rgb565_buffer
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gdi_capture_backend_can_be_forced_by_environment() {
        let previous = std::env::var_os("WONREMOTE_CAPTURE_BACKEND");

        std::env::set_var("WONREMOTE_CAPTURE_BACKEND", "gdi");
        assert!(should_force_gdi_capture_backend());

        std::env::set_var("WONREMOTE_CAPTURE_BACKEND", "dxgi");
        assert!(!should_force_gdi_capture_backend());

        if let Some(value) = previous {
            std::env::set_var("WONREMOTE_CAPTURE_BACKEND", value);
        } else {
            std::env::remove_var("WONREMOTE_CAPTURE_BACKEND");
        }
    }

    #[test]
    fn gdi_capture_deselects_bitmap_before_get_dibits() {
        let source = include_str!("capturer.rs");
        let select_bitmap = source
            .find("let old_object = SelectObject(memory_dc, bitmap_object);")
            .expect("GDI bitmap selection should exist");
        let restore_bitmap = source
            .find("SelectObject(memory_dc, old_object)")
            .expect("GDI bitmap restore should exist");
        let get_dibits = source
            .find("GetDIBits(")
            .expect("GDI pixel readback should exist");

        assert!(select_bitmap < restore_bitmap);
        assert!(restore_bitmap < get_dibits);
    }

    #[test]
    fn gdi_capture_geometry_preserves_secondary_monitor_offsets() {
        assert_eq!(
            gdi_capture_geometry(RECT {
                left: -1600,
                top: 120,
                right: 0,
                bottom: 1020,
            }),
            Some((-1600, 120, 1600, 900)),
        );
        assert_eq!(gdi_capture_geometry(RECT::default()), None);
    }
}
