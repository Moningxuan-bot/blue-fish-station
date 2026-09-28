// mkbg.cs - cover-crop, high-quality resample and unsharp a background image.
// Source kept pure ASCII.
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.Runtime.InteropServices;

static class MkBg
{
    static int Main(string[] a)
    {
        if (a.Length < 4) { Console.WriteLine("usage: mkbg.exe <in> <out.jpg> <W> <H> [sharpen]"); return 1; }
        string inp = a[0], outp = a[1];
        int W = int.Parse(a[2]), H = int.Parse(a[3]);
        double amount = a.Length > 4 ? double.Parse(a[4], CultureInfo.InvariantCulture) : 0;
        using (Bitmap src = new Bitmap(inp))
        {
            double targetAspect = (double)W / H;
            double srcAspect = (double)src.Width / src.Height;
            Rectangle crop;
            if (srcAspect > targetAspect)
            {
                int cw = (int)Math.Round(src.Height * targetAspect);
                crop = new Rectangle((src.Width - cw) / 2, 0, cw, src.Height);
            }
            else
            {
                int ch = (int)Math.Round(src.Width / targetAspect);
                crop = new Rectangle(0, (src.Height - ch) / 2, src.Width, ch);
            }
            Console.WriteLine("source " + src.Width + "x" + src.Height + " -> crop " + crop.Width + "x" + crop.Height + " -> " + W + "x" + H);
            using (Bitmap dst = new Bitmap(W, H, PixelFormat.Format24bppRgb))
            {
                using (Graphics g = Graphics.FromImage(dst))
                {
                    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    g.SmoothingMode = SmoothingMode.HighQuality;
                    g.DrawImage(src, new Rectangle(0, 0, W, H), crop, GraphicsUnit.Pixel);
                }
                if (amount > 0) Sharpen(dst, amount);
                ImageCodecInfo jpg = null;
                foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders())
                    if (c.FormatID == ImageFormat.Jpeg.Guid) jpg = c;
                EncoderParameters ep = new EncoderParameters(1);
                ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 92L);
                dst.Save(outp, jpg, ep);
            }
        }
        Console.WriteLine("wrote " + outp);
        return 0;
    }

    // 3x3 Laplacian unsharp, done on a locked buffer so it stays fast.
    static void Sharpen(Bitmap bmp, double amount)
    {
        int w = bmp.Width, h = bmp.Height;
        Rectangle rect = new Rectangle(0, 0, w, h);
        BitmapData data = bmp.LockBits(rect, ImageLockMode.ReadWrite, PixelFormat.Format24bppRgb);
        int stride = data.Stride;
        byte[] src = new byte[stride * h];
        Marshal.Copy(data.Scan0, src, 0, src.Length);
        byte[] dst = new byte[src.Length];
        Buffer.BlockCopy(src, 0, dst, 0, src.Length);
        for (int y = 1; y < h - 1; y++)
        {
            for (int x = 1; x < w - 1; x++)
            {
                int i = y * stride + x * 3;
                for (int c = 0; c < 3; c++)
                {
                    int center = src[i + c];
                    int sum = src[i - 3 + c] + src[i + 3 + c] + src[i - stride + c] + src[i + stride + c];
                    double v = center + amount * (center * 4 - sum) / 4.0;
                    if (v < 0) v = 0;
                    if (v > 255) v = 255;
                    dst[i + c] = (byte)v;
                }
            }
        }
        Marshal.Copy(dst, 0, data.Scan0, dst.Length);
        bmp.UnlockBits(data);
    }
}
