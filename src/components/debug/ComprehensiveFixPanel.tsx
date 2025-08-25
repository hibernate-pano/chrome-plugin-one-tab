/**
 * 综合问题修复面板
 * 专门用于解决去重后190个标签的异常问题
 */

import React, { useState, useEffect } from 'react';
import { Button, Card, Typography, Space, Alert, Collapse, Progress, Divider, Steps } from 'antd';
import { 
  BugOutlined, 
  ToolOutlined,
  WifiOutlined,
  SyncOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  ReloadOutlined,
  ThunderboltOutlined
} from '@ant-design/icons';

const { Title, Text, Paragraph } = Typography;
const { Panel } = Collapse;
const { Step } = Steps;

interface ComprehensiveFixPanelProps {
  visible?: boolean;
  onClose?: () => void;
}

export const ComprehensiveFixPanel: React.FC<ComprehensiveFixPanelProps> = ({ visible = true, onClose }) => {
  const [currentStep, setCurrentStep] = useState(0);
  const [isFixing, setIsFixing] = useState(false);
  const [fixProgress, setFixProgress] = useState(0);
  const [fixResults, setFixResults] = useState<any[]>([]);
  const [networkStatus, setNetworkStatus] = useState<any>(null);

  /**
   * 执行综合修复
   */
  const executeComprehensiveFix = async () => {
    setIsFixing(true);
    setFixProgress(0);
    setFixResults([]);
    setCurrentStep(0);

    try {
      // 步骤1: 网络健康检查
      setCurrentStep(1);
      setFixProgress(20);
      
      const { checkNetworkHealth } = await import('@/utils/networkHealthChecker');
      const networkHealth = await checkNetworkHealth();
      setNetworkStatus(networkHealth);
      
      setFixResults(prev => [...prev, {
        step: '网络健康检查',
        success: networkHealth.issues.length === 0,
        message: networkHealth.issues.length === 0 ? '网络状态良好' : `发现 ${networkHealth.issues.length} 个网络问题`,
        details: networkHealth
      }]);

      // 步骤2: 网络问题修复
      if (networkHealth.issues.length > 0) {
        setCurrentStep(2);
        setFixProgress(40);
        
        const { fixNetworkIssues } = await import('@/utils/networkHealthChecker');
        const networkFix = await fixNetworkIssues();
        
        setFixResults(prev => [...prev, {
          step: '网络问题修复',
          success: networkFix.success,
          message: networkFix.message,
          details: networkFix
        }]);
      }

      // 步骤3: 紧急同步修复
      setCurrentStep(3);
      setFixProgress(60);
      
      const { performEmergencyFix } = await import('@/utils/emergencySync');
      const emergencyFix = await performEmergencyFix();
      
      setFixResults(prev => [...prev, {
        step: '紧急同步修复',
        success: emergencyFix.success,
        message: emergencyFix.message,
        details: emergencyFix
      }]);

      // 步骤4: 数据一致性验证
      setCurrentStep(4);
      setFixProgress(80);
      
      // 等待一段时间让数据稳定
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // 验证修复结果
      const verification = await verifyFixResults();
      
      setFixResults(prev => [...prev, {
        step: '数据一致性验证',
        success: verification.success,
        message: verification.message,
        details: verification
      }]);

      // 完成
      setCurrentStep(5);
      setFixProgress(100);

    } catch (error) {
      setFixResults(prev => [...prev, {
        step: '修复过程',
        success: false,
        message: `修复失败: ${error instanceof Error ? error.message : '未知错误'}`,
        details: { error }
      }]);
    } finally {
      setIsFixing(false);
    }
  };

  /**
   * 验证修复结果
   */
  const verifyFixResults = async (): Promise<{ success: boolean; message: string; tabCount: number }> => {
    try {
      const { storage } = await import('@/shared/utils/storage');
      const groups = await storage.getGroups();
      const totalTabs = groups.reduce((sum, g) => sum + g.tabs.length, 0);

      // 检查是否还有重复标签
      const allUrls = new Set<string>();
      const duplicateUrls = new Set<string>();
      
      groups.forEach(group => {
        group.tabs.forEach(tab => {
          if (tab.url) {
            if (allUrls.has(tab.url)) {
              duplicateUrls.add(tab.url);
            }
            allUrls.add(tab.url);
          }
        });
      });

      const hasDuplicates = duplicateUrls.size > 0;
      
      return {
        success: !hasDuplicates,
        message: hasDuplicates 
          ? `仍有 ${duplicateUrls.size} 个重复标签，总计 ${totalTabs} 个标签`
          : `数据一致性良好，总计 ${totalTabs} 个标签`,
        tabCount: totalTabs
      };
    } catch (error) {
      return {
        success: false,
        message: '验证失败',
        tabCount: 0
      };
    }
  };

  /**
   * 快速诊断
   */
  const quickDiagnosis = async () => {
    try {
      const { quickDiagnostic } = await import('@/utils/syncDiagnostics');
      const result = await quickDiagnostic();
      
      console.group('🔍 快速诊断结果');
      console.log('问题数量:', result.issues.length);
      console.log('系统信息:', result.systemInfo);
      console.log('建议操作:', result.recommendations);
      console.groupEnd();
      
      alert(`诊断完成！发现 ${result.issues.length} 个问题。详细信息请查看控制台。`);
    } catch (error) {
      alert('诊断失败，请检查控制台错误信息');
    }
  };

  if (!visible) {
    return null;
  }

  const fixSteps = [
    '准备修复',
    '网络健康检查',
    '网络问题修复',
    '紧急同步修复',
    '数据一致性验证',
    '修复完成'
  ];

  return (
    <Card
      title={
        <Space>
          <ThunderboltOutlined />
          <span>综合问题修复面板</span>
        </Space>
      }
      extra={
        <Space>
          <Button 
            icon={<BugOutlined />} 
            onClick={quickDiagnosis}
            size="small"
          >
            快速诊断
          </Button>
          {onClose && (
            <Button onClick={onClose} size="small">
              关闭
            </Button>
          )}
        </Space>
      }
      style={{ margin: '16px', maxWidth: '900px' }}
    >
      {/* 问题描述 */}
      <Alert
        message="检测到数据同步异常"
        description="去重操作后出现190个标签的异常情况，可能由网络不稳定或同步服务冲突导致。"
        type="warning"
        showIcon
        style={{ marginBottom: '16px' }}
      />

      {/* 一键修复按钮 */}
      <div style={{ textAlign: 'center', marginBottom: '24px' }}>
        <Button
          type="primary"
          size="large"
          icon={<ToolOutlined />}
          onClick={executeComprehensiveFix}
          loading={isFixing}
          disabled={isFixing}
        >
          {isFixing ? '正在修复...' : '一键综合修复'}
        </Button>
      </div>

      {/* 修复进度 */}
      {isFixing && (
        <div style={{ marginBottom: '24px' }}>
          <Progress 
            percent={fixProgress} 
            status={fixProgress === 100 ? 'success' : 'active'}
            strokeColor={{
              '0%': '#108ee9',
              '100%': '#87d068',
            }}
          />
          <Steps current={currentStep} size="small" style={{ marginTop: '16px' }}>
            {fixSteps.map((step, index) => (
              <Step key={index} title={step} />
            ))}
          </Steps>
        </div>
      )}

      {/* 修复结果 */}
      {fixResults.length > 0 && (
        <Collapse defaultActiveKey={['results']} style={{ marginBottom: '16px' }}>
          <Panel header="修复结果" key="results">
            <Space direction="vertical" style={{ width: '100%' }}>
              {fixResults.map((result, index) => (
                <Alert
                  key={index}
                  message={result.step}
                  description={result.message}
                  type={result.success ? 'success' : 'error'}
                  showIcon
                  icon={result.success ? <CheckCircleOutlined /> : <ExclamationCircleOutlined />}
                />
              ))}
            </Space>
          </Panel>
        </Collapse>
      )}

      {/* 网络状态 */}
      {networkStatus && (
        <Collapse ghost style={{ marginBottom: '16px' }}>
          <Panel header="网络状态详情" key="network">
            <Space direction="vertical" style={{ width: '100%' }}>
              <div>
                <Text strong>连接状态: </Text>
                <Text type={networkStatus.isOnline ? 'success' : 'danger'}>
                  {networkStatus.isOnline ? '在线' : '离线'}
                </Text>
              </div>
              
              <div>
                <Text strong>Supabase可达性: </Text>
                <Text type={networkStatus.supabaseReachable ? 'success' : 'danger'}>
                  {networkStatus.supabaseReachable ? '可达' : '不可达'}
                </Text>
              </div>

              {networkStatus.latency > 0 && (
                <div>
                  <Text strong>网络延迟: </Text>
                  <Text type={networkStatus.latency > 3000 ? 'warning' : 'success'}>
                    {networkStatus.latency}ms
                  </Text>
                </div>
              )}

              {networkStatus.issues.length > 0 && (
                <div>
                  <Text strong>发现的问题:</Text>
                  <ul>
                    {networkStatus.issues.map((issue: string, index: number) => (
                      <li key={index}>{issue}</li>
                    ))}
                  </ul>
                </div>
              )}

              {networkStatus.recommendations.length > 0 && (
                <div>
                  <Text strong>建议操作:</Text>
                  <ul>
                    {networkStatus.recommendations.map((rec: string, index: number) => (
                      <li key={index}>{rec}</li>
                    ))}
                  </ul>
                </div>
              )}
            </Space>
          </Panel>
        </Collapse>
      )}

      <Divider />

      {/* 使用说明 */}
      <Collapse ghost>
        <Panel header="使用说明" key="help">
          <Paragraph>
            <Title level={5}>修复流程:</Title>
            <ol>
              <li><strong>网络健康检查:</strong> 检测网络连接和Supabase服务状态</li>
              <li><strong>网络问题修复:</strong> 自动修复检测到的网络问题</li>
              <li><strong>紧急同步修复:</strong> 停用冲突服务，强制数据同步和去重</li>
              <li><strong>数据验证:</strong> 验证修复后的数据一致性</li>
            </ol>
            
            <Title level={5}>预期效果:</Title>
            <ul>
              <li>解决网络连接不稳定问题</li>
              <li>修复同步服务冲突</li>
              <li>确保去重操作的正确性</li>
              <li>恢复多设备间的数据一致性</li>
            </ul>

            <Title level={5}>注意事项:</Title>
            <ul>
              <li>修复过程中请保持网络连接稳定</li>
              <li>修复完成后建议重启浏览器</li>
              <li>如果问题持续存在，请联系技术支持</li>
            </ul>
          </Paragraph>
        </Panel>
      </Collapse>
    </Card>
  );
};

export default ComprehensiveFixPanel;
