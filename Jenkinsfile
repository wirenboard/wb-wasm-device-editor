pipeline {
    agent {
        label 'devenv'
    }
    stages {
        stage('Build WASM Module') {
            agent {
                docker {
                    image 'registry.wirenboard.lan/emsdk:latest'
                    args '--entrypoint="" -u root:root'
                    reuseNode true
                }
            }
            steps {
                sh 'bash -c "source /emsdk/emsdk_env.sh; emmake make -f wasm.mk"'
            }
        }
        stage('Build configurator') {
            agent {
                docker {
                    image 'node:22.14.0'
                    args '--entrypoint="" -u root:root'
                    reuseNode true
                }
            }
            steps {
                dir(path: 'submodule/homeui/frontend') {
                    sh 'npm install'
                }
                dir(path: 'wasm') {
                    sh 'npm install'
                    sh 'npm run build'
                    sh 'tar czf dist-configurator.tar.gz dist-configurator'
                }
            }
            post {
                success {
                    archiveArtifacts artifacts: 'wasm/dist-configurator.tar.gz', fingerprint: true
                }
            }
        }
    }
}
