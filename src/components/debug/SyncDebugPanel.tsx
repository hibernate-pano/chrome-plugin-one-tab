/**
 * 同步调试面板
 * 用于诊断和修复同步问题的开发者工具
 */

import React, { useState, useEffect } from 'react';
import { Button, Card, Typography, Space, Alert, Collapse, Tag, Divider } from 'antd';
import { 
  BugOutlined, 
  SyncOutlined, 
  CheckCircleOutlined, 
  ExclamationCircleOutlined,
  WarningOutlined,
  InfoCircleOutlined,
  ReloadOutlined,
  ToolOutlined
} from '@ant-design/icons';

const { Title, Text, Paragraph } = Typography;
const { Panel } = Collapse;

interface SyncDebugPanelProps {
  visible?: boolean;
  onClose?: () => void;
}

export const SyncDebugPanel: React.FC<SyncDebugPanelProps> = ({ visible = true, onClose }) => {
  const [diagnosticResult, setDiagnosticResult] = useState<any>(null);
  const [isRunningDiagnostic, setIsRunningDiagnostic] = useState(false);
  const [isFixing, setIsFixing] = useState(false);
  const [fixResult, setFixResult] = useState<any>(null);

  /**
   * 运行诊断
   */
  const runDiagnostic = async () => {
    setIsRunningDiagnostic(true);
    try {
      const { quickDiagnostic } = await import('@/utils/syncDiagnostics');
      const result = await quickDiagnostic();
      setDiagnosticResult(result);
    } catch (error) {
      console.error('诊断失败:', error);
    } finally {
      setIsRunningDiagnostic(false);
    }
  };

  /**
   * 执行自动修复
   */
  const executeAutoFix = async () => {
    setIsFixing(true);
    try {
      const { autoFixSyncServices } = await import('@/services/syncInitializer');
      const result = await autoFixSyncServices();
      setFixResult(result);
      
      // 修复后重新运行诊断
      if (result.success) {
        setTimeout(() => {
          runDiagnostic();
        }, 1000);
      }
    } catch (error) {
      console.error('自动修复失败:', error);
      setFixResult({
        success: false,
        message: '自动修复失败',
        actions: []
      });
    } finally {
      setIsFixing(false);
    }
  };

  /**
   * 手动执行去重测试
   */
  const testDeduplication = async () => {
    try {
      const { unifiedSyncService } = await import('@/services/UnifiedSyncService');
      const result = await unifiedSyncService.performDeduplication();
      
      alert(`去重测试结果: ${result.message}`);
      
      // 重新运行诊断
      runDiagnostic();
    } catch (error) {
      alert(`去重测试失败: ${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  /**
   * 获取问题类型图标
   */
  const getIssueIcon = (type: string) => {
    switch (type) {
      case 'error':
        return <ExclamationCircleOutlined style={{ color: '#ff4d4f' }} />;
      case 'warning':
        return <WarningOutlined style={{ color: '#faad14' }} />;
      case 'info':
        return <InfoCircleOutlined style={{ color: '#1890ff' }} />;
      default:
        return <InfoCircleOutlined />;
    }
  };

  /**
   * 获取问题类型颜色
   */
  const getIssueColor = (type: string) => {
    switch (type) {
      case 'error':
        return 'error';
      case 'warning':
        return 'warning';
      case 'info':
        return 'processing';
      default:
        return 'default';
    }
  };

  // 组件挂载时自动运行诊断
  useEffect(() => {
    if (visible) {
      runDiagnostic();
    }
  }, [visible]);

  if (!visible) {
    return null;
  }

  return (
    <Card
      title={
        <Space>
          <BugOutlined />
          <span>同步问题诊断面板</span>
        </Space>
      }
      extra={
        <Space>
          <Button 
            icon={<ReloadOutlined />} 
            onClick={runDiagnostic}
            loading={isRunningDiagnostic}
            size="small"
          >
            重新诊断
          </Button>
          {onClose && (
            <Button onClick={onClose} size="small">
              关闭
            </Button>
          )}
        </Space>
      }
      style={{ margin: '16px', maxWidth: '800px' }}
    >
      {/* 快速操作区 */}
      <Space wrap style={{ marginBottom: '16px' }}>
        <Button 
          type="primary" 
          icon={<ToolOutlined />}
          onClick={executeAutoFix}
          loading={isFixing}
        >
          自动修复
        </Button>
        <Button 
          icon={<SyncOutlined />}
          onClick={testDeduplication}
        >
          测试去重功能
        </Button>
      </Space>

      {/* 修复结果显示 */}
      {fixResult && (
        <Alert
          message={fixResult.message}
          type={fixResult.success ? 'success' : 'error'}
          showIcon
          closable
          style={{ marginBottom: '16px' }}
          description={
            fixResult.actions.length > 0 && (
              <div>
                <Text strong>执行的操作:</Text>
                <ul>
                  {fixResult.actions.map((action: string, index: number) => (
                    <li key={index}>{action}</li>
                  ))}
                </ul>
              </div>
            )
          }
        />
      )}

      {/* 诊断结果 */}
      {diagnosticResult && (
        <Collapse defaultActiveKey={['summary', 'issues']} ghost>
          {/* 概要信息 */}
          <Panel 
            header="诊断概要" 
            key="summary"
            extra={
              <Tag color={diagnosticResult.issues.some((i: any) => i.type === 'error') ? 'red' : 'green'}>
                {diagnosticResult.issues.length} 个问题
              </Tag>
            }
          >
            <Space direction="vertical" style={{ width: '100%' }}>
              <div>
                <Text strong>诊断时间: </Text>
                <Text>{new Date(diagnosticResult.timestamp).toLocaleString()}</Text>
              </div>
              
              <div>
                <Text strong>系统状态: </Text>
                <Tag color={diagnosticResult.systemInfo.isAuthenticated ? 'green' : 'red'}>
                  {diagnosticResult.systemInfo.isAuthenticated ? '已登录' : '未登录'}
                </Tag>
                <Tag color="blue">
                  本地: {diagnosticResult.systemInfo.localGroupsCount} 组
                </Tag>
                <Tag color="purple">
                  云端: {diagnosticResult.systemInfo.cloudGroupsCount} 组
                </Tag>
                <Tag color={diagnosticResult.systemInfo.networkStatus === 'online' ? 'green' : 'red'}>
                  {diagnosticResult.systemInfo.networkStatus === 'online' ? '在线' : '离线'}
                </Tag>
              </div>

              {diagnosticResult.recommendations.length > 0 && (
                <div>
                  <Text strong>建议操作:</Text>
                  <ul>
                    {diagnosticResult.recommendations.map((rec: string, index: number) => (
                      <li key={index}>{rec}</li>
                    ))}
                  </ul>
                </div>
              )}
            </Space>
          </Panel>

          {/* 问题详情 */}
          <Panel header="问题详情" key="issues">
            <Space direction="vertical" style={{ width: '100%' }}>
              {diagnosticResult.issues.map((issue: any, index: number) => (
                <Card 
                  key={index} 
                  size="small"
                  style={{ 
                    borderLeft: `4px solid ${
                      issue.type === 'error' ? '#ff4d4f' : 
                      issue.type === 'warning' ? '#faad14' : '#1890ff'
                    }`
                  }}
                >
                  <Space>
                    {getIssueIcon(issue.type)}
                    <Tag color={getIssueColor(issue.type)}>{issue.category}</Tag>
                    <Text strong>{issue.message}</Text>
                  </Space>
                  
                  {issue.solution && (
                    <div style={{ marginTop: '8px' }}>
                      <Text type="secondary">解决方案: {issue.solution}</Text>
                    </div>
                  )}
                  
                  {issue.details && (
                    <div style={{ marginTop: '8px' }}>
                      <Text code style={{ fontSize: '12px' }}>
                        {JSON.stringify(issue.details, null, 2)}
                      </Text>
                    </div>
                  )}
                </Card>
              ))}

              {diagnosticResult.issues.length === 0 && (
                <Alert
                  message="系统状态良好"
                  description="未发现同步相关问题"
                  type="success"
                  showIcon
                  icon={<CheckCircleOutlined />}
                />
              )}
            </Space>
          </Panel>

          {/* 系统信息 */}
          <Panel header="系统信息" key="system">
            <pre style={{ 
              background: '#f5f5f5', 
              padding: '12px', 
              borderRadius: '4px',
              fontSize: '12px',
              overflow: 'auto'
            }}>
              {JSON.stringify(diagnosticResult.systemInfo, null, 2)}
            </pre>
          </Panel>
        </Collapse>
      )}

      {/* 加载状态 */}
      {isRunningDiagnostic && !diagnosticResult && (
        <div style={{ textAlign: 'center', padding: '40px' }}>
          <SyncOutlined spin style={{ fontSize: '24px', marginBottom: '16px' }} />
          <div>正在运行诊断...</div>
        </div>
      )}

      <Divider />
      
      {/* 使用说明 */}
      <Collapse ghost>
        <Panel header="使用说明" key="help">
          <Paragraph>
            <Title level={5}>功能说明:</Title>
            <ul>
              <li><strong>自动修复:</strong> 自动检测并修复常见的同步问题</li>
              <li><strong>测试去重功能:</strong> 手动测试去重操作是否正常工作</li>
              <li><strong>重新诊断:</strong> 重新运行完整的系统诊断</li>
            </ul>
            
            <Title level={5}>问题类型:</Title>
            <ul>
              <li><strong>错误 (红色):</strong> 需要立即解决的严重问题</li>
              <li><strong>警告 (黄色):</strong> 可能影响功能的潜在问题</li>
              <li><strong>信息 (蓝色):</strong> 系统状态信息</li>
            </ul>
          </Paragraph>
        </Panel>
      </Collapse>
    </Card>
  );
};

export default SyncDebugPanel;
