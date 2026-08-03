# Shadcn/UI 组件提示词

## 可用组件

以下组件可直接 import 使用：

```js
import { Alert, AlertDescription, AlertTitle, AlertDialog, AlertDialogAction } from '/components/ui/alert';
import { Avatar, AvatarFallback, AvatarImage } from '/components/ui/avatar';
import { Badge } from '/components/ui/badge';
import { Button } from '/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '/components/ui/card';
import { Checkbox } from '/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '/components/ui/dropdown-menu';
import { Input } from '/components/ui/input';
import { Label } from '/components/ui/label';
import { Progress } from '/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '/components/ui/select';
import { Separator } from '/components/ui/separator';
import { Slider } from '/components/ui/slider';
import { Switch } from '/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '/components/ui/tabs';
import { Textarea } from '/components/ui/textarea';
import { Toast, ToastAction, ToastDescription, ToastProvider, ToastTitle, ToastViewport } from '/components/ui/toast';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '/components/ui/tooltip';
```

## 可用库

- React (useState, useEffect, etc.)
- lucide-react 图标库
- recharts 图表库
- Tailwind CSS 样式
- date-fns 日期处理

## 规则
- 使用 Tailwind 类名，不要用任意值（如 h-[600px]）
- 组件必须从 /components/ui/name 导入
- 不要引入其他第三方库
- 组件必须完整可用，不能有省略号或占位符
