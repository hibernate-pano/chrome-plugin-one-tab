# OneTabPlus 安全性增强指南

本文档提供了针对 OneTabPlus Chrome 扩展的安全性增强建议，重点关注数据保护、用户认证和隐私保障。

## 安全现状分析

OneTabPlus 已经实现了一些基本的安全措施，如数据加密和认证缓存。但随着用户数据的增加和功能的扩展，安全性需要进一步加强。

## 改进策略

### 1. 端到端加密

实现真正的端到端加密，确保数据在服务器上也无法被解密，只有用户本人能够访问数据。

**实施方案**：

```javascript
// 使用用户密码派生的密钥进行加密
import { pbkdf2Sync, randomBytes, createCipheriv, createDecipheriv } from 'crypto';

// 密钥派生函数
const deriveKey = (password, salt) => {
  return pbkdf2Sync(password, salt, 100000, 32, 'sha256');
};

// 加密函数
const encryptData = async (data, password) => {
  // 生成随机盐值
  const salt = randomBytes(16);
  
  // 从密码派生密钥
  const key = deriveKey(password, salt);
  
  // 生成随机初始化向量
  const iv = randomBytes(16);
  
  // 创建加密器
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  
  // 加密数据
  let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'base64');
  encrypted += cipher.final('base64');
  
  // 获取认证标签
  const authTag = cipher.getAuthTag();
  
  // 返回加密结果
  return {
    encrypted,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    version: 'v2' // 加密版本标识
  };
};

// 解密函数
const decryptData = async (encryptedData, password) => {
  // 解析加密数据
  const { encrypted, salt, iv, authTag, version } = encryptedData;
  
  // 从密码派生密钥
  const key = deriveKey(
    password, 
    Buffer.from(salt, 'base64')
  );
  
  // 创建解密器
  const decipher = createDecipheriv(
    'aes-256-gcm', 
    key, 
    Buffer.from(iv, 'base64')
  );
  
  // 设置认证标签
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  
  // 解密数据
  let decrypted = decipher.update(encrypted, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  
  // 解析并返回解密后的数据
  return JSON.parse(decrypted);
};

// 在同步过程中使用
const syncToCloud = async (tabGroups, password) => {
  // 加密数据
  const encryptedData = await encryptData(tabGroups, password);
  
  // 上传加密数据
  await supabase
    .from('tab_groups')
    .upsert({
      user_id: currentUser.id,
      encrypted_data: encryptedData,
      updated_at: new Date().toISOString()
    });
};

// 从云端同步
const syncFromCloud = async (password) => {
  // 获取加密数据
  const { data, error } = await supabase
    .from('tab_groups')
    .select('encrypted_data')
    .eq('user_id', currentUser.id)
    .single();
  
  if (error) throw error;
  
  // 解密数据
  return await decryptData(data.encrypted_data, password);
};
```

### 2. 密码策略增强

增加密码强度检查和定期密码更新提醒，提高账户安全性。

**实施方案**：

```javascript
// 密码强度检查函数
const checkPasswordStrength = (password) => {
  // 密码长度至少8位
  if (password.length < 8) {
    return {
      strength: 'weak',
      message: '密码长度至少需要8位'
    };
  }
  
  // 检查密码复杂度
  const hasLowerCase = /[a-z]/.test(password);
  const hasUpperCase = /[A-Z]/.test(password);
  const hasNumbers = /\d/.test(password);
  const hasSpecialChars = /[!@#$%^&*(),.?":{}|<>]/.test(password);
  
  const complexity = [hasLowerCase, hasUpperCase, hasNumbers, hasSpecialChars]
    .filter(Boolean).length;
  
  if (complexity < 2) {
    return {
      strength: 'weak',
      message: '密码需要包含大写字母、小写字母、数字或特殊字符中的至少两种'
    };
  }
  
  if (complexity < 3) {
    return {
      strength: 'medium',
      message: '密码强度中等，建议包含大写字母、小写字母、数字和特殊字符'
    };
  }
  
  return {
    strength: 'strong',
    message: '密码强度良好'
  };
};

// 密码更新提醒
const checkPasswordAge = async () => {
  const { data } = await supabase
    .from('user_profiles')
    .select('password_updated_at')
    .eq('user_id', currentUser.id)
    .single();
  
  if (data && data.password_updated_at) {
    const passwordUpdatedAt = new Date(data.password_updated_at);
    const now = new Date();
    const monthsSinceUpdate = (now.getFullYear() - passwordUpdatedAt.getFullYear()) * 12 + 
                              now.getMonth() - passwordUpdatedAt.getMonth();
    
    // 如果密码超过3个月未更新，提醒用户
    if (monthsSinceUpdate >= 3) {
      return {
        shouldUpdate: true,
        message: `您的密码已经 ${monthsSinceUpdate} 个月未更新，建议定期更换密码以提高账户安全性`
      };
    }
  }
  
  return { shouldUpdate: false };
};

// 在注册和修改密码表单中使用
const PasswordInput = ({ value, onChange }) => {
  const [passwordStrength, setPasswordStrength] = useState(null);
  
  useEffect(() => {
    if (value) {
      setPasswordStrength(checkPasswordStrength(value));
    } else {
      setPasswordStrength(null);
    }
  }, [value]);
  
  return (
    <div>
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 border rounded"
      />
      {passwordStrength && (
        <div className={`text-sm mt-1 ${
          passwordStrength.strength === 'weak' ? 'text-red-500' :
          passwordStrength.strength === 'medium' ? 'text-yellow-500' :
          'text-green-500'
        }`}>
          {passwordStrength.message}
        </div>
      )}
    </div>
  );
};
```

### 3. 敏感数据处理

确保所有敏感数据（如认证令牌）都安全存储，避免在本地存储中明文保存。

**实施方案**：

```javascript
// 安全存储服务
class SecureStorage {
  constructor() {
    this.encryptionKey = null;
  }
  
  // 初始化加密密钥
  async initialize() {
    // 尝试从安全存储获取密钥
    const { encryptionKey } = await chrome.storage.local.get('encryptionKey');
    
    if (encryptionKey) {
      this.encryptionKey = encryptionKey;
    } else {
      // 生成新的加密密钥
      const buffer = new Uint8Array(32);
      crypto.getRandomValues(buffer);
      this.encryptionKey = Array.from(buffer)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
      
      // 保存密钥
      await chrome.storage.local.set({ encryptionKey: this.encryptionKey });
    }
  }
  
  // 加密数据
  async encrypt(data) {
    if (!this.encryptionKey) {
      await this.initialize();
    }
    
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(JSON.stringify(data));
    
    // 使用 SubtleCrypto API 加密
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(this.encryptionKey),
      { name: 'AES-GCM' },
      false,
      ['encrypt']
    );
    
    // 生成随机 IV
    const iv = crypto.getRandomValues(new Uint8Array(12));
    
    // 加密数据
    const encryptedBuffer = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv
      },
      key,
      dataBuffer
    );
    
    // 转换为 Base64
    const encryptedArray = Array.from(new Uint8Array(encryptedBuffer));
    const ivArray = Array.from(iv);
    
    return {
      encrypted: btoa(String.fromCharCode.apply(null, encryptedArray)),
      iv: btoa(String.fromCharCode.apply(null, ivArray))
    };
  }
  
  // 解密数据
  async decrypt(encryptedData) {
    if (!this.encryptionKey) {
      await this.initialize();
    }
    
    const { encrypted, iv } = encryptedData;
    
    const encoder = new TextEncoder();
    
    // 转换回二进制
    const encryptedBuffer = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
    const ivBuffer = Uint8Array.from(atob(iv), c => c.charCodeAt(0));
    
    // 导入密钥
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(this.encryptionKey),
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );
    
    // 解密数据
    const decryptedBuffer = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: ivBuffer
      },
      key,
      encryptedBuffer
    );
    
    // 转换为 JSON
    const decoder = new TextDecoder();
    return JSON.parse(decoder.decode(decryptedBuffer));
  }
  
  // 安全存储数据
  async setItem(key, value) {
    const encryptedData = await this.encrypt(value);
    await chrome.storage.local.set({ [key]: encryptedData });
  }
  
  // 获取安全存储的数据
  async getItem(key) {
    const result = await chrome.storage.local.get(key);
    if (!result[key]) return null;
    
    return await this.decrypt(result[key]);
  }
  
  // 删除数据
  async removeItem(key) {
    await chrome.storage.local.remove(key);
  }
}

// 使用安全存储服务
const secureStorage = new SecureStorage();

// 存储认证令牌
const storeAuthToken = async (token) => {
  await secureStorage.setItem('authToken', token);
};

// 获取认证令牌
const getAuthToken = async () => {
  return await secureStorage.getItem('authToken');
};
```

### 4. 安全审计与漏洞扫描

定期进行安全审计，检查潜在的安全漏洞。

**实施方案**：

```javascript
// 安全自检函数
const performSecurityAudit = async () => {
  const auditResults = {
    issues: [],
    recommendations: []
  };
  
  // 检查存储的敏感数据
  const sensitiveKeys = ['authToken', 'refreshToken', 'userPassword'];
  for (const key of sensitiveKeys) {
    const plainData = await chrome.storage.local.get(key);
    if (plainData[key]) {
      auditResults.issues.push(`发现明文存储的敏感数据: ${key}`);
      auditResults.recommendations.push(`使用 SecureStorage 加密存储 ${key}`);
    }
  }
  
  // 检查内容安全策略
  const manifest = chrome.runtime.getManifest();
  if (!manifest.content_security_policy) {
    auditResults.issues.push('未设置内容安全策略');
    auditResults.recommendations.push('在 manifest.json 中添加严格的内容安全策略');
  }
  
  // 检查权限使用
  const permissions = manifest.permissions || [];
  const hostPermissions = manifest.host_permissions || [];
  
  const unusedPermissions = []; // 实际检测中填充未使用的权限
  if (unusedPermissions.length > 0) {
    auditResults.issues.push(`发现未使用的权限: ${unusedPermissions.join(', ')}`);
    auditResults.recommendations.push('移除未使用的权限以减少安全风险');
  }
  
  // 检查第三方库的安全性
  // 这里需要实际集成漏洞扫描工具
  
  return auditResults;
};

// 定期执行安全审计
chrome.alarms.create('securityAudit', { periodInMinutes: 60 * 24 * 7 }); // 每周执行一次

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'securityAudit') {
    performSecurityAudit().then(results => {
      if (results.issues.length > 0) {
        console.warn('安全审计发现问题:', results);
        // 可以选择向开发者发送报告
      }
    });
  }
});
```

### 5. 数据访问控制

实现细粒度的数据访问控制，确保用户只能访问自己的数据。

**实施方案**：

```sql
-- Supabase Row Level Security 策略

-- 创建表
CREATE TABLE tab_groups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  encrypted_data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 启用 RLS
ALTER TABLE tab_groups ENABLE ROW LEVEL SECURITY;

-- 创建策略：用户只能查看自己的数据
CREATE POLICY "Users can view their own tab groups" 
ON tab_groups FOR SELECT 
USING (auth.uid() = user_id);

-- 创建策略：用户只能插入自己的数据
CREATE POLICY "Users can insert their own tab groups" 
ON tab_groups FOR INSERT 
WITH CHECK (auth.uid() = user_id);

-- 创建策略：用户只能更新自己的数据
CREATE POLICY "Users can update their own tab groups" 
ON tab_groups FOR UPDATE 
USING (auth.uid() = user_id);

-- 创建策略：用户只能删除自己的数据
CREATE POLICY "Users can delete their own tab groups" 
ON tab_groups FOR DELETE 
USING (auth.uid() = user_id);
```

## 隐私保护增强

### 1. 隐私政策更新

更新隐私政策，明确说明数据收集和使用方式。

**实施方案**：

```javascript
// 隐私政策组件
const PrivacyPolicy = () => {
  return (
    <div className="privacy-policy">
      <h2>隐私政策</h2>
      
      <section>
        <h3>数据收集</h3>
        <p>OneTabPlus 收集以下数据：</p>
        <ul>
          <li>您保存的标签页信息（标题、URL、图标）</li>
          <li>您的账户信息（电子邮件地址）</li>
          <li>应用使用统计（如果您选择启用）</li>
        </ul>
      </section>
      
      <section>
        <h3>数据使用</h3>
        <p>我们使用收集的数据：</p>
        <ul>
          <li>提供标签同步服务</li>
          <li>改进用户体验</li>
          <li>解决技术问题</li>
        </ul>
      </section>
      
      <section>
        <h3>数据保护</h3>
        <p>我们通过以下方式保护您的数据：</p>
        <ul>
          <li>端到端加密</li>
          <li>安全的数据传输（HTTPS）</li>
          <li>严格的访问控制</li>
        </ul>
      </section>
      
      <section>
        <h3>数据共享</h3>
        <p>我们不会与第三方共享您的个人数据，除非：</p>
        <ul>
          <li>您明确授权</li>
          <li>法律要求</li>
        </ul>
      </section>
      
      <section>
        <h3>您的权利</h3>
        <p>您有权：</p>
        <ul>
          <li>访问您的数据</li>
          <li>更正不准确的数据</li>
          <li>删除您的数据</li>
          <li>限制数据处理</li>
        </ul>
      </section>
    </div>
  );
};
```

## 成功指标

实施上述安全性增强后，预期可以达到以下效果：

1. **数据安全**：敏感数据100%加密存储
2. **账户安全**：账户被盗风险降低80%
3. **合规性**：满足GDPR等隐私法规要求
4. **用户信任**：用户对数据安全的信心提升50%

## 持续改进建议

安全是一个持续的过程，建议：

1. 定期进行安全审计和漏洞扫描
2. 关注安全最佳实践的更新
3. 监控安全事件和威胁情报
4. 建立安全响应流程，及时处理安全问题

## 参考资源

- [Chrome 扩展安全最佳实践](https://developer.chrome.com/docs/extensions/mv3/security/)
- [Web 加密 API](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto)
- [Supabase 安全指南](https://supabase.com/docs/guides/auth/row-level-security)
- [OWASP 安全指南](https://owasp.org/www-project-web-security-testing-guide/)
