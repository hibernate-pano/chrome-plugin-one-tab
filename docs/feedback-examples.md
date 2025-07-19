# OneTab Plus 反馈系统使用示例

## 基础用法

### 1. 使用 feedback 工具类

```typescript
import { feedback } from '@/shared/utils/feedback';
import { FEEDBACK_MESSAGES } from '@/shared/constants/feedbackMessages';

// 成功反馈
feedback.success(FEEDBACK_MESSAGES.SYNC.SUCCESS);

// 错误反馈
feedback.error(FEEDBACK_MESSAGES.SYNC.ERROR);

// 警告反馈
feedback.warning(FEEDBACK_MESSAGES.SYNC.CONFLICT_DETECTED);

// 信息反馈
feedback.info(FEEDBACK_MESSAGES.NETWORK.OFFLINE);

// 加载反馈
const loadingId = feedback.loading(FEEDBACK_MESSAGES.SYNC.START);
// 操作完成后关闭
feedback.dismissLoading(loadingId);
```

### 2. 使用 useAsyncOperation Hook

```typescript
import { useAsyncOperation } from '@/shared/hooks/useAsyncOperation';
import { FEEDBACK_MESSAGES } from '@/shared/constants/feedbackMessages';

const MyComponent = () => {
  const operation = useAsyncOperation({
    loadingMessage: FEEDBACK_MESSAGES.SYNC.START,
    successMessage: FEEDBACK_MESSAGES.SYNC.SUCCESS,
    errorMessage: FEEDBACK_MESSAGES.SYNC.ERROR,
  });

  const handleSync = async () => {
    await operation.execute(async () => {
      // 执行同步操作
      return await syncService.syncAll();
    });
  };

  return (
    <LoadingButton
      loading={operation.isLoading}
      onClick={handleSync}
    >
      同步数据
    </LoadingButton>
  );
};
```

### 3. 使用 LoadingButton 组件

```typescript
import { LoadingButton } from '@/shared/components/LoadingButton/LoadingButton';

const MyForm = () => {
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      await submitForm();
      feedback.success(FEEDBACK_MESSAGES.COMMON.SUCCESS);
    } catch (error) {
      feedback.error(FEEDBACK_MESSAGES.COMMON.ERROR);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <LoadingButton
      loading={isSubmitting}
      loadingText="提交中..."
      variant="primary"
      onClick={handleSubmit}
    >
      提交
    </LoadingButton>
  );
};
```

## 高级用法

### 1. 带操作按钮的反馈

```typescript
// 错误反馈带重试按钮
feedback.error(FEEDBACK_MESSAGES.NETWORK.CONNECTION_ERROR, {
  retryAction: () => handleRetry(),
});

// 成功反馈带下一步操作
feedback.success(FEEDBACK_MESSAGES.SYNC.SUCCESS, {
  nextAction: {
    label: '查看详情',
    onClick: () => showDetails(),
  },
});

// 冲突反馈带解决按钮
feedback.conflictError(() => showConflictResolution());
```

### 2. 专用反馈方法

```typescript
// 同步操作反馈
const syncId = feedback.sync.start();
try {
  await syncOperation();
  feedback.sync.success(syncId);
} catch (error) {
  if (isConflictError(error)) {
    feedback.sync.conflict(() => resolveConflict(), syncId);
  } else {
    feedback.sync.error(error.message, () => retrySync(), syncId);
  }
}

// 认证操作反馈
try {
  await login(email, password);
  feedback.auth.loginSuccess();
} catch (error) {
  feedback.auth.loginError(error.message);
}

// 文件操作反馈
try {
  await uploadFile(file);
  feedback.file.uploadSuccess(file.name);
} catch (error) {
  feedback.file.uploadError(file.name, error.message);
}
```

### 3. 批量操作反馈

```typescript
const handleBatchDelete = async (selectedItems: Item[]) => {
  if (selectedItems.length === 0) {
    feedback.warning(FEEDBACK_MESSAGES.BATCH.SELECT_ITEMS);
    return;
  }

  const loadingId = feedback.loading(
    FEEDBACK_MESSAGES.BATCH.PROCESSING(0, selectedItems.length)
  );

  let success = 0;
  let failed = 0;

  for (let i = 0; i < selectedItems.length; i++) {
    try {
      await deleteItem(selectedItems[i]);
      success++;
    } catch (error) {
      failed++;
    }

    // 更新进度
    feedback.loading(
      FEEDBACK_MESSAGES.BATCH.PROCESSING(i + 1, selectedItems.length),
      { id: loadingId }
    );
  }

  feedback.dismissLoading(loadingId);
  feedback.batchOperation(selectedItems.length, success, failed);
};
```

## 表单验证示例

```typescript
import { FEEDBACK_MESSAGES } from '@/shared/constants/feedbackMessages';

const validateForm = (data: FormData) => {
  const errors: Record<string, string> = {};

  if (!data.email) {
    errors.email = FEEDBACK_MESSAGES.VALIDATION.REQUIRED_FIELD;
  } else if (!isValidEmail(data.email)) {
    errors.email = FEEDBACK_MESSAGES.VALIDATION.INVALID_EMAIL;
  }

  if (!data.password) {
    errors.password = FEEDBACK_MESSAGES.VALIDATION.REQUIRED_FIELD;
  } else if (data.password.length < 8) {
    errors.password = FEEDBACK_MESSAGES.VALIDATION.MIN_LENGTH(8);
  }

  return errors;
};

const MyForm = () => {
  const [formData, setFormData] = useState({ email: '', password: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    const validationErrors = validateForm(formData);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      feedback.error('请修正表单中的错误');
      return;
    }

    try {
      await submitForm(formData);
      feedback.success('表单提交成功');
    } catch (error) {
      feedback.error('表单提交失败，请重试');
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <div>
        <input
          type="email"
          value={formData.email}
          onChange={(e) => setFormData({ ...formData, email: e.target.value })}
          className={errors.email ? 'border-red-500' : ''}
        />
        {errors.email && (
          <span className="text-red-500 text-sm">{errors.email}</span>
        )}
      </div>
      
      <div>
        <input
          type="password"
          value={formData.password}
          onChange={(e) => setFormData({ ...formData, password: e.target.value })}
          className={errors.password ? 'border-red-500' : ''}
        />
        {errors.password && (
          <span className="text-red-500 text-sm">{errors.password}</span>
        )}
      </div>
      
      <LoadingButton type="submit">
        提交
      </LoadingButton>
    </form>
  );
};
```

## 网络状态处理

```typescript
const NetworkAwareComponent = () => {
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      feedback.info(FEEDBACK_MESSAGES.NETWORK.ONLINE);
    };

    const handleOffline = () => {
      setIsOnline(false);
      feedback.warning(FEEDBACK_MESSAGES.NETWORK.OFFLINE);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const handleSyncWithRetry = async () => {
    try {
      await syncData();
      feedback.success(FEEDBACK_MESSAGES.SYNC.SUCCESS);
    } catch (error) {
      if (!isOnline) {
        feedback.warning(FEEDBACK_MESSAGES.NETWORK.OFFLINE);
      } else {
        feedback.networkError(() => handleSyncWithRetry());
      }
    }
  };

  return (
    <div>
      <div className={`status-indicator ${isOnline ? 'online' : 'offline'}`}>
        {isOnline ? '在线' : '离线'}
      </div>
      <LoadingButton onClick={handleSyncWithRetry}>
        同步数据
      </LoadingButton>
    </div>
  );
};
```

## 自定义反馈组件

```typescript
import { feedback } from '@/shared/utils/feedback';

const CustomFeedbackComponent = () => {
  const showCustomSuccess = () => {
    feedback.success('自定义成功消息', {
      duration: 5000,
      nextAction: {
        label: '查看详情',
        onClick: () => console.log('查看详情'),
      },
    });
  };

  const showCustomError = () => {
    feedback.error('自定义错误消息', {
      retryAction: () => console.log('重试操作'),
      contactSupport: true,
    });
  };

  const showProgressFeedback = async () => {
    const steps = ['初始化', '处理数据', '保存结果', '完成'];
    
    for (let i = 0; i < steps.length; i++) {
      const loadingId = `step-${i}`;
      feedback.loading(`${steps[i]}...`, { id: loadingId });
      
      // 模拟异步操作
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      feedback.dismissLoading(loadingId);
      
      if (i < steps.length - 1) {
        feedback.info(`${steps[i]}完成`);
      }
    }
    
    feedback.success('所有步骤完成！');
  };

  return (
    <div className="space-y-4">
      <button onClick={showCustomSuccess}>
        显示自定义成功消息
      </button>
      <button onClick={showCustomError}>
        显示自定义错误消息
      </button>
      <button onClick={showProgressFeedback}>
        显示进度反馈
      </button>
    </div>
  );
};
```

## 最佳实践

1. **使用标准消息常量**：优先使用 `FEEDBACK_MESSAGES` 中定义的标准消息
2. **提供具体的错误信息**：避免使用模糊的错误消息，提供具体的错误原因和解决建议
3. **合理设置显示时间**：成功消息3秒，错误和警告消息5秒，重要信息不自动关闭
4. **提供操作按钮**：对于错误消息，尽可能提供重试或解决方案按钮
5. **保持一致性**：在整个应用中使用统一的反馈模式和样式
6. **考虑可访问性**：确保反馈信息对屏幕阅读器友好
7. **避免过度反馈**：不要为每个微小操作都显示反馈，保持用户界面的清洁
