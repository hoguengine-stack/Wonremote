use windows::core::{ComInterface, Result};
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
                if let Err(e) = self.init_duplication() {
                    return Err(e);
                }
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

                    // 2. Convert to 16-bit RGB565 (2 bytes per pixel) and measure time
                    let convert_start = std::time::Instant::now();
                    let mut rgb565_buffer = vec![0u8; width * height * 2];

                    for i in 0..(width * height) {
                        let bgra_idx = i * 4;
                        let rgb565_idx = i * 2;

                        let b = bgra_buffer[bgra_idx];
                        let g = bgra_buffer[bgra_idx + 1];
                        let r = bgra_buffer[bgra_idx + 2];

                        // Convert R (5 bits), G (6 bits), B (5 bits)
                        let r5 = (r >> 3) as u16;
                        let g6 = (g >> 2) as u16;
                        let b5 = (b >> 3) as u16;

                        let rgb565_val = (r5 << 11) | (g6 << 5) | b5;

                        // Store as little-endian
                        rgb565_buffer[rgb565_idx] = (rgb565_val & 0xFF) as u8;
                        rgb565_buffer[rgb565_idx + 1] = ((rgb565_val >> 8) & 0xFF) as u8;
                    }
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
