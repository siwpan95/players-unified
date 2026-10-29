import tkinter as tk
import random
import math
import time
from collections import deque

class WMPVisualizer:
    """模拟Windows Media Player可视化效果"""
    
    def __init__(self, width=800, height=600):
        self.root = tk.Tk()
        self.root.title("Windows Media Player 可视化效果模拟")
        self.canvas = tk.Canvas(self.root, width=width, height=height, bg='black')
        self.canvas.pack()
        
        self.width = width
        self.height = height
        self.effect_type = "bars"  # 默认效果
        self.frame_count = 0
        
        # 模拟音频数据（1024个频率区域，如WMP的TimedLevel数据[10](@ref)）
        self.freq_data = [random.random() for _ in range(1024)]
        self.history = deque(maxlen=50)  # 历史数据用于平滑
        
        # 创建效果选择菜单
        self.create_menu()
        
    def create_menu(self):
        """创建效果选择菜单"""
        menu_frame = tk.Frame(self.root)
        menu_frame.pack(side=tk.BOTTOM, fill=tk.X)
        
        effects = [
            ("条形图", "bars"),
            ("尖峰", "spikes"),
            ("波浪", "waves"),
            ("粒子", "particles"),
            ("漩涡", "vortex"),
            ("迷幻", "psychedelic")
        ]
        
        for text, effect in effects:
            btn = tk.Button(menu_frame, text=text, 
                          command=lambda e=effect: self.set_effect(e))
            btn.pack(side=tk.LEFT, padx=5, pady=5)
    
    def set_effect(self, effect):
        """设置可视化效果类型"""
        self.effect_type = effect
        self.canvas.delete("all")
    
    def update_audio_data(self):
        """更新模拟的音频数据（随机生成）"""
        # 模拟音频频谱变化
        for i in range(len(self.freq_data)):
            # 添加随机变化和低频振荡
            change = random.uniform(-0.1, 0.1)
            oscillation = math.sin(self.frame_count * 0.1 + i * 0.01) * 0.05
            self.freq_data[i] = max(0, min(1, self.freq_data[i] + change + oscillation))
        
        self.history.append(self.freq_data.copy())
        self.frame_count += 1
    
    def draw_bars(self):
        """绘制条形图效果（类似WMP的Bars效果）"""
        bar_width = self.width // 64
        for i in range(64):
            # 获取对应频率区域的数据
            idx = i * 16
            value = sum(self.freq_data[idx:idx+16]) / 16
            
            x1 = i * bar_width
            x2 = x1 + bar_width - 2
            height = int(value * self.height * 0.8)
            y1 = self.height - height
            y2 = self.height
            
            # 根据频率位置设置颜色（低频-红色，高频-紫色）
            hue = i / 64
            color = self.hsv_to_rgb(hue, 0.8, 1.0)
            
            self.canvas.create_rectangle(x1, y1, x2, y2, 
                                       fill=color, outline=color)
    
    def draw_spikes(self):
        """绘制尖峰效果（类似WMP的Spikes效果）"""
        center_x = self.width // 2
        center_y = self.height // 2
        max_radius = min(center_x, center_y) - 20
        
        for i in range(128):
            angle = (i / 128) * 2 * math.pi
            idx = i * 8
            value = sum(self.freq_data[idx:idx+8]) / 8
            
            # 计算尖峰位置
            radius = 20 + value * max_radius
            x1 = center_x
            y1 = center_y
            x2 = center_x + radius * math.cos(angle)
            y2 = center_y + radius * math.sin(angle)
            
            # 颜色渐变
            hue = (self.frame_count * 0.01 + i * 0.01) % 1.0
            color = self.hsv_to_rgb(hue, 0.9, 1.0)
            
            self.canvas.create_line(x1, y1, x2, y2, 
                                  fill=color, width=2)
    
    def draw_waves(self):
        """绘制波浪效果"""
        points = []
        for x in range(self.width):
            # 将x位置映射到频率索引
            idx = int((x / self.width) * len(self.freq_data))
            value = self.freq_data[idx] if idx < len(self.freq_data) else 0
            
            # 添加多个频率叠加
            y_offset = 0
            for freq_mult in [1, 2, 4, 8]:
                wave_idx = int((x / self.width) * len(self.freq_data) * freq_mult) % len(self.freq_data)
                wave_value = self.freq_data[wave_idx] if wave_idx < len(self.freq_data) else 0
                y_offset += math.sin(x * 0.02 * freq_mult + self.frame_count * 0.1) * wave_value * 20
            
            y = self.height // 2 + value * 100 + y_offset
            points.append((x, y))
        
        # 绘制波浪线
        for i in range(len(points) - 1):
            x1, y1 = points[i]
            x2, y2 = points[i + 1]
            
            # 根据高度设置颜色
            height_ratio = (y1 + y2) / (2 * self.height)
            color = self.hsv_to_rgb(height_ratio, 0.8, 1.0)
            
            self.canvas.create_line(x1, y1, x2, y2, 
                                  fill=color, width=2)
    
    def draw_particles(self):
        """绘制粒子效果（类似Headspace的迷幻效果[1](@ref)）"""
        particle_count = 200
        
        for i in range(particle_count):
            # 粒子位置基于音频数据
            freq_idx = i % len(self.freq_data)
            value = self.freq_data[freq_idx]
            
            # 计算粒子位置
            angle = (i / particle_count) * 2 * math.pi + self.frame_count * 0.01
            radius = 50 + value * 200
            
            x = self.width // 2 + radius * math.cos(angle)
            y = self.height // 2 + radius * math.sin(angle)
            
            # 粒子大小和颜色
            size = 2 + value * 8
            hue = (angle / (2 * math.pi) + self.frame_count * 0.005) % 1.0
            color = self.hsv_to_rgb(hue, 0.9, 1.0)
            
            self.canvas.create_oval(x-size, y-size, x+size, y+size,
                                  fill=color, outline=color)
    
    def draw_vortex(self):
        """绘制漩涡效果"""
        center_x = self.width // 2
        center_y = self.height // 2
        
        for ring in range(10):
            ring_radius = 30 + ring * 40
            points = []
            
            for i in range(100):
                angle = (i / 100) * 2 * math.pi
                
                # 添加音频驱动的扭曲
                freq_idx = int((angle / (2 * math.pi)) * len(self.freq_data))
                value = self.freq_data[freq_idx] if freq_idx < len(self.freq_data) else 0
                
                twist = math.sin(angle * 3 + self.frame_count * 0.05) * value * 50
                current_radius = ring_radius + twist
                
                x = center_x + current_radius * math.cos(angle + self.frame_count * 0.02)
                y = center_y + current_radius * math.sin(angle + self.frame_count * 0.02)
                points.append((x, y))
            
            # 绘制环
            for i in range(len(points) - 1):
                x1, y1 = points[i]
                x2, y2 = points[i + 1]
                
                hue = (ring / 10 + self.frame_count * 0.01) % 1.0
                color = self.hsv_to_rgb(hue, 0.7, 1.0)
                
                self.canvas.create_line(x1, y1, x2, y2, 
                                      fill=color, width=2)
    
    def draw_psychedelic(self):
        """绘制迷幻效果（模拟Headspace[1](@ref)）"""
        # 绘制背景渐变
        for y in range(0, self.height, 10):
            hue = (y / self.height + self.frame_count * 0.005) % 1.0
            color = self.hsv_to_rgb(hue, 0.3, 0.2)
            self.canvas.create_rectangle(0, y, self.width, y+10, 
                                       fill=color, outline=color)
        
        # 绘制流动形状
        shape_count = 20
        for i in range(shape_count):
            size = 30 + self.freq_data[i * 50] * 100
            x = self.width // 2 + math.sin(self.frame_count * 0.02 + i * 0.5) * 200
            y = self.height // 2 + math.cos(self.frame_count * 0.015 + i * 0.3) * 150
            
            hue = (i / shape_count + self.frame_count * 0.01) % 1.0
            color = self.hsv_to_rgb(hue, 0.8, 1.0)
            
            # 随机形状
            if random.random() > 0.5:
                self.canvas.create_oval(x-size, y-size, x+size, y+size,
                                      fill=color, outline=color, width=0)
            else:
                points = []
                for j in range(6):
                    angle = j * math.pi / 3 + self.frame_count * 0.01
                    px = x + size * math.cos(angle)
                    py = y + size * math.sin(angle)
                    points.append(px)
                    points.append(py)
                self.canvas.create_polygon(points, fill=color, outline=color)
    
    def hsv_to_rgb(self, h, s, v):
        """HSV转RGB颜色"""
        if s == 0:
            r = g = b = int(v * 255)
        else:
            h = h * 6
            i = int(h)
            f = h - i
            p = v * (1 - s)
            q = v * (1 - s * f)
            t = v * (1 - s * (1 - f))
            
            if i == 0:
                r, g, b = v, t, p
            elif i == 1:
                r, g, b = q, v, p
            elif i == 2:
                r, g, b = p, v, t
            elif i == 3:
                r, g, b = p, q, v
            elif i == 4:
                r, g, b = t, p, v
            else:
                r, g, b = v, p, q
        
        return f'#{int(r*255):02x}{int(g*255):02x}{int(b*255):02x}'
    
    def update_frame(self):
        """更新帧"""
        self.canvas.delete("all")
        self.update_audio_data()
        
        # 根据当前效果类型绘制
        if self.effect_type == "bars":
            self.draw_bars()
        elif self.effect_type == "spikes":
            self.draw_spikes()
        elif self.effect_type == "waves":
            self.draw_waves()
        elif self.effect_type == "particles":
            self.draw_particles()
        elif self.effect_type == "vortex":
            self.draw_vortex()
        elif self.effect_type == "psychedelic":
            self.draw_psychedelic()
        
        # 添加帧率显示
        self.canvas.create_text(10, 10, text=f"效果: {self.effect_type}", 
                              fill="white", anchor="nw", font=("Arial", 12))
        
        # 下一帧
        self.root.after(50, self.update_frame)  # 约20fps
    
    def run(self):
        """运行可视化程序"""
        self.update_frame()
        self.root.mainloop()

# 使用示例
if __name__ == "__main__":
    # 创建并运行可视化器
    visualizer = WMPVisualizer(width=1024, height=768)
    visualizer.run()