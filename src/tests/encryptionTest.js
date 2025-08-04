// 加密测试脚本
import { encryptData, decryptData, isEncrypted } from '../utils/encryptionUtils';

// 测试数据
const testData = {
  name: 'Test Group',
  tabs: [
    { id: '1', url: 'https://example.com', title: 'Example' },
    { id: '2', url: 'https://test.com', title: 'Test' }
  ]
};

// 测试用户ID
const userId = 'test-user-123';

// 测试加密和解密
async function testEncryption() {
  console.log('原始数据:', testData);
  
  try {
    // 加密数据
    console.log('正在加密数据...');
    const encrypted = await encryptData(testData, userId);
    console.log('加密后的数据:', encrypted);
    console.log('数据是否已加密:', isEncrypted(encrypted));
    
    // 解密数据
    console.log('正在解密数据...');
    const decrypted = await decryptData(encrypted, userId);
    console.log('解密后的数据:', decrypted);
    
    // 验证解密后的数据是否与原始数据相同
    console.log('解密后的数据与原始数据相同:', 
      JSON.stringify(decrypted) === JSON.stringify(testData));
    
    // 测试兼容性 - 尝试解密未加密的数据
    console.log('测试兼容性 - 解密未加密的数据...');
    const jsonString = JSON.stringify(testData);
    const compatDecrypted = await decryptData(jsonString, userId);
    console.log('兼容性解密结果:', compatDecrypted);
    console.log('兼容性解密后的数据与原始数据相同:', 
      JSON.stringify(compatDecrypted) === JSON.stringify(testData));
    
    console.log('测试完成!');
  } catch (error) {
    console.error('测试失败:', error);
  }
}

// 运行测试
testEncryption();
